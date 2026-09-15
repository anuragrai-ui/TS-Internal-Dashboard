import { createHash } from "node:crypto";

import { getCachedOcrTextForIssue } from "@/lib/attachmentOcr";
import { getFallbackAnalysis } from "@/lib/mlEscalationModel";
import type { FormattedIssue, TicketCommentContext } from "@/lib/jiraClient";
import { getTicketCommentContext } from "@/lib/jiraClient";
import {
  callChatCompletionChain,
  getApiKey,
  getChainMaxRetries,
  getChainTimeoutMs,
  getModelChain,
  getProvider,
  isEscalationEnabled,
} from "@/lib/llmClient";
import { getRedis, isRedisConfigured } from "@/lib/redis";

function isReasoningEnabled(): boolean {
  return process.env.OPENROUTER_REASONING_ENABLED !== "false";
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getDefaultAnalysisLimit(): number {
  return parseIntEnv(process.env.ESCALATION_ANALYSIS_LIMIT, 25);
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
  ocrText: string;
}

interface RawAnalysis {
  key?: unknown;
  next_action?: unknown;
  reason?: unknown;
  risk_level?: unknown;
  risk_score?: unknown;
}

const ANALYSIS_CACHE_PREFIX = "escalation:analysis:";
const ANALYSIS_CACHE_TTL_SECONDS = 1800;

function analysisCacheKey(rawKey: string): string {
  const hash = createHash("sha256").update(rawKey).digest("hex");
  return `${ANALYSIS_CACHE_PREFIX}${hash}`;
}

async function getAnalysisCache(
  key: string,
): Promise<TicketEscalationAnalysis[] | null> {
  if (!isRedisConfigured()) {
    return null;
  }

  try {
    return await getRedis().get<TicketEscalationAnalysis[]>(analysisCacheKey(key));
  } catch (error) {
    console.warn("Escalation analysis cache read failed; treating as a cache miss.", error);
    return null;
  }
}

async function setAnalysisCache(
  key: string,
  value: TicketEscalationAnalysis[],
): Promise<void> {
  if (!isRedisConfigured()) {
    return;
  }

  try {
    await getRedis().set(analysisCacheKey(key), value, {
      ex: ANALYSIS_CACHE_TTL_SECONDS,
    });
  } catch (error) {
    console.warn("Escalation analysis cache write failed; continuing without caching this result.", error);
  }
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
  raw: RawAnalysis,
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

async function parseAnalyses(
  text: string,
  inputs: TicketAnalysisInput[],
): Promise<TicketEscalationAnalysis[]> {
  const jsonStart = text.indexOf("[");
  const jsonEnd = text.lastIndexOf("]");

  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    return Promise.all(inputs.map(({ comments, issue }) => getFallbackAnalysis(issue, comments)));
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  } catch {
    return Promise.all(inputs.map(({ comments, issue }) => getFallbackAnalysis(issue, comments)));
  }

  if (!Array.isArray(parsed)) {
    return Promise.all(inputs.map(({ comments, issue }) => getFallbackAnalysis(issue, comments)));
  }

  const byKey = new Map(
    parsed
      .filter((item): item is RawAnalysis => Boolean(item))
      .map((item) => [typeof item.key === "string" ? item.key : "", item]),
  );

  return inputs.map(({ issue }) =>
    normalizeAnalysis(byKey.get(issue.key) ?? {}, issue),
  );
}

function buildPrompt(inputs: TicketAnalysisInput[]): string {
  return `You are a support escalation triage assistant. Analyze Jira tickets and recent comments. Return only a valid JSON array, no markdown fences. Each object must have: key, risk_level ("immediate" | "watch" | "normal"), risk_score (0-100), reason, next_action.

Mark "immediate" when the ticket may cause client escalation, SLA urgency, blocker language, repeated client follow-up, production impact, angry/frustrated tone, missed response, or external dependency risk. When present, pending_reason explains WHY a ticket is stalled rather than being itself a risk signal - do not automatically treat every ticket with a pending_reason as high risk. attachment_text (when present) is OCR'd text from the ticket's image/PDF attachments - treat it as additional ticket context, same as the description or comments.

Tickets:
${JSON.stringify(
  inputs.map(({ comments, issue, ocrText }) => ({
    action_date: issue.action_date,
    assignee: issue.assignee,
    attachment_text: ocrText || undefined,
    comments,
    key: issue.key,
    latest_comment_created: issue.latest_comment_created,
    pending_reason: issue.pending_reason,
    priority: issue.priority,
    project: issue.project,
    reporter: issue.reporter,
    severity: issue.severity,
    status: issue.status,
    summary: issue.summary,
    updated: issue.updated,
  })),
  null,
  2,
)}`;
}

async function callAiForAnalysis(
  inputs: TicketAnalysisInput[],
): Promise<TicketEscalationAnalysis[] | null> {
  const apiKey = getApiKey();

  if (!isEscalationEnabled() || !apiKey) {
    return Promise.all(inputs.map(({ comments, issue }) => getFallbackAnalysis(issue, comments)));
  }

  const provider = getProvider();
  const extraBody: Record<string, unknown> = {};

  if (provider === "openrouter") {
    extraBody.reasoning = { enabled: isReasoningEnabled() };
    extraBody.response_format = { type: "json_object" };
  }

  const isFastChain = provider === "nvidia";

  const text = await callChatCompletionChain(buildPrompt(inputs), {
    extraBody,
    maxTokens: 4096,
    models: getModelChain(),
    perModelMaxRetries: isFastChain ? getChainMaxRetries() : undefined,
    perModelTimeoutMs: isFastChain ? getChainTimeoutMs() : undefined,
    temperature: 0.1,
  });

  if (text === null) {
    return null;
  }

  return parseAnalyses(text, inputs);
}

export async function analyzeEscalationRisk(
  issues: FormattedIssue[],
  limit = getDefaultAnalysisLimit(),
  getComments: (issueKey: string) => Promise<TicketCommentContext[]> = getTicketCommentContext,
): Promise<TicketEscalationAnalysis[]> {
  const scopedIssues = issues.slice(0, limit);
  const cacheKey = buildCacheKey(scopedIssues);
  const cached = await getAnalysisCache(cacheKey);

  if (cached) {
    return cached;
  }

  let inputs: TicketAnalysisInput[];

  try {
    inputs = await Promise.all(
      scopedIssues.map(async (issue) => ({
        comments: await getComments(issue.key),
        issue,
        ocrText: await getCachedOcrTextForIssue(issue),
      })),
    );
  } catch (error) {
    console.warn(
      "Failed to fetch ticket comments for escalation analysis; using ML/local fallback.",
      error,
    );
    const fallback = await Promise.all(scopedIssues.map((issue) => getFallbackAnalysis(issue)));
    await setAnalysisCache(cacheKey, fallback);
    return fallback;
  }

  try {
    const analyses = await callAiForAnalysis(inputs);

    if (analyses) {
      await setAnalysisCache(cacheKey, analyses);
      return analyses;
    }

    console.warn("Every model in the escalation chain failed; using ML/local fallback.");
  } catch (error) {
    console.warn("Unexpected error during AI escalation analysis; using ML/local fallback.", error);
  }

  const fallback = await Promise.all(
    inputs.map(({ comments, issue }) => getFallbackAnalysis(issue, comments)),
  );
  await setAnalysisCache(cacheKey, fallback);
  return fallback;
}
