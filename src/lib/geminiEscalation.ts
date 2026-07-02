import { getLocalHeuristicAnalysis } from "@/lib/escalationHeuristics";
import type { FormattedIssue, TicketCommentContext } from "@/lib/jiraClient";
import { getTicketCommentContext } from "@/lib/jiraClient";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

function getPrimaryModel(): string {
  return process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite";
}

function getFallbackModel(): string {
  return process.env.GEMINI_FALLBACK_MODEL ?? "gemini-2.5-flash";
}

function getGeminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY;
}

function isGeminiEnabled(): boolean {
  return process.env.GEMINI_ESCALATION_ENABLED === "true";
}
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_DELAY_MS = 10_000;
const FALLBACK_COOLDOWN_MS = 500;

function getMaxRetries(): number {
  return Number.parseInt(process.env.GEMINI_MAX_RETRIES ?? "4", 10);
}

function getRequestTimeoutMs(): number {
  return Number.parseInt(process.env.GEMINI_REQUEST_TIMEOUT_MS ?? "30000", 10);
}

function getBaseDelayMs(): number {
  return Number.parseInt(process.env.GEMINI_BASE_DELAY_MS ?? "500", 10);
}

export type EscalationRiskLevel = "immediate" | "watch" | "normal" | "unknown";

export interface TicketEscalationAnalysis {
  key: string;
  next_action: string;
  reason: string;
  risk_level: EscalationRiskLevel;
  risk_score: number;
}

interface TicketAnalysisInput {
  comments: TicketCommentContext[];
  issue: FormattedIssue;
}

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
}

interface RawGeminiAnalysis {
  key?: unknown;
  next_action?: unknown;
  reason?: unknown;
  risk_level?: unknown;
  risk_score?: unknown;
}

const analysisCache = new Map<string, TicketEscalationAnalysis[]>();

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function jitteredDelay(attempt: number): number {
  const baseDelayMs = getBaseDelayMs();
  const base = Math.min(baseDelayMs * 2 ** (attempt - 1), MAX_DELAY_MS);
  const jitter = Math.random() * base * 0.5;

  return Math.round(base + jitter);
}

function buildCacheKey(issues: FormattedIssue[]): string {
  return issues
    .map((issue) =>
      [
        issue.key,
        issue.updated ?? "",
        issue.latest_comment_created,
        issue.status ?? "",
        issue.priority,
      ].join(":"),
    )
    .join("|");
}

function normalizeRiskLevel(value: unknown): EscalationRiskLevel {
  if (value === "immediate" || value === "watch" || value === "normal") {
    return value;
  }

  return "unknown";
}

function normalizeAnalysis(
  raw: RawGeminiAnalysis,
  fallbackIssue: FormattedIssue,
): TicketEscalationAnalysis {
  const riskScore =
    typeof raw.risk_score === "number" && Number.isFinite(raw.risk_score)
      ? Math.max(0, Math.min(100, Math.round(raw.risk_score)))
      : 0;

  return {
    key: typeof raw.key === "string" ? raw.key : fallbackIssue.key,
    next_action:
      typeof raw.next_action === "string" && raw.next_action.trim()
        ? raw.next_action
        : "Review the ticket and latest comment manually.",
    reason:
      typeof raw.reason === "string" && raw.reason.trim()
        ? raw.reason
        : "No clear AI reason was returned.",
    risk_level: normalizeRiskLevel(raw.risk_level),
    risk_score: riskScore,
  };
}

function extractGeminiText(response: GeminiGenerateResponse): string {
  return (
    response.candidates
      ?.flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim() ?? ""
  );
}

function parseAnalyses(text: string, issues: FormattedIssue[]): TicketEscalationAnalysis[] {
  const jsonStart = text.indexOf("[");
  const jsonEnd = text.lastIndexOf("]");

  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    return issues.map((issue) => getLocalHeuristicAnalysis(issue));
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  } catch {
    return issues.map((issue) => getLocalHeuristicAnalysis(issue));
  }

  if (!Array.isArray(parsed)) {
    return issues.map((issue) => getLocalHeuristicAnalysis(issue));
  }

  const byKey = new Map(
    parsed
      .filter((item): item is RawGeminiAnalysis => Boolean(item))
      .map((item) => [typeof item.key === "string" ? item.key : "", item]),
  );

  return issues.map((issue) =>
    normalizeAnalysis(byKey.get(issue.key) ?? {}, issue),
  );
}

function buildPrompt(inputs: TicketAnalysisInput[]): string {
  return `You are a support escalation triage assistant. Analyze Jira tickets and recent comments. Return only valid JSON array, no markdown. Each object must have: key, risk_level ("immediate" | "watch" | "normal"), risk_score (0-100), reason, next_action.

Mark "immediate" when the ticket may cause client escalation, SLA urgency, blocker language, repeated client follow-up, production impact, angry/frustrated tone, missed response, or external dependency risk.

Tickets:
${JSON.stringify(
  inputs.map(({ comments, issue }) => ({
    action_date: issue.action_date,
    assignee: issue.assignee,
    comments,
    key: issue.key,
    latest_comment_created: issue.latest_comment_created,
    priority: issue.priority,
    project: issue.project,
    reporter: issue.reporter,
    status: issue.status,
    summary: issue.summary,
    updated: issue.updated,
  })),
  null,
  2,
)}`;
}

async function callGemini(
  model: string,
  inputs: TicketAnalysisInput[],
): Promise<TicketEscalationAnalysis[] | null> {
  const apiKey = getGeminiApiKey();

  if (!isGeminiEnabled() || !apiKey) {
    return inputs.map(({ comments, issue }) => getLocalHeuristicAnalysis(issue, comments));
  }

  const maxRetries = getMaxRetries();

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetch(
        `${GEMINI_ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: buildPrompt(inputs),
                  },
                ],
              },
            ],
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.1,
            },
          }),
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
          signal: AbortSignal.timeout(getRequestTimeoutMs()),
        },
      );

      if (response.ok) {
        const data = (await response.json()) as GeminiGenerateResponse;
        const text = extractGeminiText(data);

        return parseAnalyses(
          text,
          inputs.map(({ issue }) => issue),
        );
      }

      if (!RETRYABLE_STATUSES.has(response.status)) {
        console.warn(
          `Gemini ${model} returned non-retryable status ${response.status}; aborting.`,
        );
        return null;
      }

      console.warn(
        `Gemini ${model} returned ${response.status} (attempt ${attempt}/${maxRetries}).`,
      );

      if (attempt < maxRetries) {
        await wait(jitteredDelay(attempt));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `Gemini ${model} network error on attempt ${attempt}/${maxRetries}: ${message}`,
      );

      if (attempt < maxRetries) {
        await wait(jitteredDelay(attempt));
      }
    }
  }

  console.warn(`Gemini ${model} exhausted all ${maxRetries} attempts.`);
  return null;
}

export async function analyzeEscalationRisk(
  issues: FormattedIssue[],
  limit = 12,
  getComments: (issueKey: string) => Promise<TicketCommentContext[]> = getTicketCommentContext,
): Promise<TicketEscalationAnalysis[]> {
  const scopedIssues = issues.slice(0, limit);
  const cacheKey = buildCacheKey(scopedIssues);
  const cached = analysisCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const inputs = await Promise.all(
    scopedIssues.map(async (issue) => ({
      comments: await getComments(issue.key),
      issue,
    })),
  );

  try {
    const primary = await callGemini(getPrimaryModel(), inputs);
    if (primary) {
      analysisCache.set(cacheKey, primary);
      return primary;
    }

    console.warn("Primary Gemini escalation analysis unavailable; trying fallback model.");
    await wait(FALLBACK_COOLDOWN_MS);

    const fallbackModel = await callGemini(getFallbackModel(), inputs);
    if (fallbackModel) {
      analysisCache.set(cacheKey, fallbackModel);
      return fallbackModel;
    }

    console.warn("Fallback Gemini escalation analysis unavailable; using local heuristics.");
  } catch (error) {
    console.warn("Unexpected error during Gemini escalation analysis; using local heuristics.", error);
  }

  const fallback = inputs.map(({ comments, issue }) =>
    getLocalHeuristicAnalysis(issue, comments),
  );
  analysisCache.set(cacheKey, fallback);
  return fallback;
}
