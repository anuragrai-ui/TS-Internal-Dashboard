import { readFile } from "node:fs/promises";
import path from "node:path";

import * as ort from "onnxruntime-node";

import { getLocalHeuristicAnalysis } from "@/lib/escalationHeuristics";
import type { FormattedIssue, TicketCommentContext } from "@/lib/jiraClient";
import type { TicketEscalationAnalysis } from "@/lib/openrouterEscalation";

/**
 * Unsupervised IsolationForest anomaly model, trained on real exported Jira
 * tickets (see ml/train_model.py). It replaces the rule-based heuristic as
 * the primary escalation-triage fallback used when OpenRouter/HuggingFace
 * are disabled or unavailable. The heuristic in escalationHeuristics.ts
 * stays as a safety net below it: if the ONNX model or runtime can't be
 * loaded (missing artifact, corrupt file, unsupported platform binary),
 * getFallbackAnalysis() degrades to the heuristic instead of throwing, the
 * same "never break the page" contract the rest of this module follows.
 *
 * There is no real "did this ticket escalate" outcome label anywhere in
 * this project, so this model was trained unsupervised (no labels used in
 * fit()) and evaluated only as a proxy agreement signal against the
 * heuristic - see ml/model/eval_report.json. risk_score/risk_level here are
 * an anomaly-score projection, not a calibrated probability.
 */

const MODEL_DIR = path.join(process.cwd(), "ml", "model");
const MODEL_PATH = path.join(MODEL_DIR, "escalation_anomaly.onnx");
const MANIFEST_PATH = path.join(MODEL_DIR, "feature_manifest.json");

interface FeatureManifest {
  feature_order: string[];
  immediate_keywords: string[];
  watch_keywords: string[];
  severity_rank_keywords: Array<[number, string[]]>;
  negative_tokens: string[];
  onnx_input_name: string;
  onnx_scores_output_name: string;
  score_immediate_threshold: number;
  score_watch_threshold: number;
  score_min: number;
  score_max: number;
}

interface ModelState {
  manifest: FeatureManifest;
  session: ort.InferenceSession;
}

let modelStatePromise: Promise<ModelState> | null = null;

async function loadModelState(): Promise<ModelState> {
  const [manifestRaw, session] = await Promise.all([
    readFile(MANIFEST_PATH, "utf8"),
    ort.InferenceSession.create(MODEL_PATH),
  ]);

  return {
    manifest: JSON.parse(manifestRaw) as FeatureManifest,
    session,
  };
}

function getModelState(): Promise<ModelState> {
  modelStatePromise ??= loadModelState().catch((error: unknown) => {
    modelStatePromise = null;
    throw error;
  });

  return modelStatePromise;
}

function severityRank(severity: string | undefined, manifest: FeatureManifest): number {
  if (!severity) {
    return 0;
  }
  const text = severity.toLowerCase();
  for (const [rank, keywords] of manifest.severity_rank_keywords) {
    if (keywords.some((keyword) => text.includes(keyword))) {
      return rank;
    }
  }
  return 3;
}

function hasValue(value: string | undefined, manifest: FeatureManifest): number {
  if (!value) {
    return 0;
  }
  return manifest.negative_tokens.includes(value.trim().toLowerCase()) ? 0 : 1;
}

function countHits(text: string, keywords: string[]): number {
  return keywords.reduce((count, keyword) => (text.includes(keyword) ? count + 1 : count), 0);
}

function daysSince(iso: string | undefined, now: number): number {
  if (!iso) {
    return 0;
  }
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return 0;
  }
  return Math.max(0, (now - parsed) / 86_400_000);
}

/**
 * Same 19-feature contract as ml/feature_schema.py compute_features().
 * Text features intentionally use summary+description only, never comment
 * bodies - the bulk Jira export used for training has no comment text, so
 * matching that at inference time avoids train/inference skew.
 */
function computeFeatures(issue: FormattedIssue, manifest: FeatureManifest): Float32Array {
  const now = Date.now();
  const signalText = [issue.summary, issue.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const affectedServicesCount = issue.affected_services
    ? issue.affected_services.split(", ").filter(Boolean).length
    : 0;

  const values: Record<string, number> = {
    affected_services_count: affectedServicesCount,
    attachment_count: issue.attachment_count,
    comment_count: issue.comment_count,
    days_since_created: daysSince(issue.created, now),
    days_since_updated: daysSince(issue.updated, now),
    has_escalation_field: hasValue(issue.escalation_field, manifest),
    has_major_incident: hasValue(issue.major_incident, manifest),
    is_done: issue.status_category === "done" ? 1 : 0,
    labels_count: issue.labels.length,
    pod_present: hasValue(issue.pod, manifest),
    priority_rank: issue.priority_sort,
    severity_rank: severityRank(issue.severity, manifest),
    source_present: hasValue(issue.source, manifest),
    subtask_count: issue.subtask_count,
    support_category_present: hasValue(issue.support_category, manifest),
    team_present: hasValue(issue.team, manifest),
    text_immediate_hits: countHits(signalText, manifest.immediate_keywords),
    text_watch_hits: countHits(signalText, manifest.watch_keywords),
    urgency_present: hasValue(issue.urgency, manifest),
  };

  return Float32Array.from(manifest.feature_order.map((name) => values[name] ?? 0));
}

function scoreToAnalysis(
  issue: FormattedIssue,
  score: number,
  manifest: FeatureManifest,
): TicketEscalationAnalysis {
  const clamped = Math.min(manifest.score_max, Math.max(manifest.score_min, score));
  const normalized = (manifest.score_max - clamped) / (manifest.score_max - manifest.score_min || 1);
  const riskScore = Math.round(Math.min(100, Math.max(0, normalized * 100)));

  if (score <= manifest.score_immediate_threshold) {
    return {
      key: issue.key,
      next_action: "Prioritize response and confirm ownership, ETA, and next step.",
      reason: "ML anomaly model flagged this ticket as a statistical outlier vs. recent tickets.",
      risk_level: "immediate",
      risk_score: riskScore,
    };
  }

  if (score <= manifest.score_watch_threshold) {
    return {
      key: issue.key,
      next_action: "Review today and send an update if the ticket is waiting on you.",
      reason: "ML anomaly model flagged this ticket as somewhat unusual vs. recent tickets.",
      risk_level: "watch",
      risk_score: riskScore,
    };
  }

  return {
    key: issue.key,
    next_action: "Handle through the normal queue unless new client activity appears.",
    reason: "ML anomaly model did not flag this ticket as unusual vs. recent tickets.",
    risk_level: "normal",
    risk_score: riskScore,
  };
}

async function scoreWithMlModel(issue: FormattedIssue): Promise<TicketEscalationAnalysis> {
  const { manifest, session } = await getModelState();
  const features = computeFeatures(issue, manifest);
  const tensor = new ort.Tensor("float32", features, [1, features.length]);
  const results = await session.run({ [manifest.onnx_input_name]: tensor });
  const scoreTensor = results[manifest.onnx_scores_output_name];
  const score = Number(scoreTensor?.data[0] ?? 0);

  return scoreToAnalysis(issue, score, manifest);
}

/**
 * Kill switch: the anomaly model was trained on the most recently *created*
 * TS tickets project-wide, which skews heavily toward fresh, low-age
 * tickets. Categories like "Waiting for Client/Product/Operations" are
 * inherently older, lingering tickets by definition, so their age features
 * look anomalous to the model almost regardless of actual risk - it was
 * over-flagging most of those tickets as "immediate". Defaults to disabled
 * (falls straight through to the rule-based heuristic) until the model is
 * retrained on a distribution that matches what each category actually
 * contains at inference time. Set ML_ESCALATION_ENABLED=true to re-enable.
 */
function isMlModelEnabled(): boolean {
  return process.env.ML_ESCALATION_ENABLED === "true";
}

export async function getFallbackAnalysis(
  issue: FormattedIssue,
  comments: TicketCommentContext[] = [],
): Promise<TicketEscalationAnalysis> {
  if (!isMlModelEnabled()) {
    return getLocalHeuristicAnalysis(issue, comments);
  }

  try {
    return await scoreWithMlModel(issue);
  } catch (error) {
    console.warn(
      `ML escalation model unavailable for ${issue.key}; using local heuristics.`,
      error,
    );
    return getLocalHeuristicAnalysis(issue, comments);
  }
}
