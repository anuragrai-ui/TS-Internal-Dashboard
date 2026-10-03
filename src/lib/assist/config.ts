import { DEFAULT_AGENT_MODEL, DEFAULT_FAST_MODEL } from "@/lib/workspace/types";

/**
 * Assist's models and switches, read at call time so a script can load its
 * env file first (same convention as readOnlyJiraConfigFromEnv).
 *
 * Both models go through src/lib/llmClient.ts with provider "anthropic":
 * - the agent model (ANTHROPIC_AGENT_MODEL, default Claude Sonnet 5.5) runs investigations
 * - the fast model (ANTHROPIC_FAST_MODEL, default Claude Haiku 4.5) writes the per-ticket summary
 */

/** Shown wherever Assist can't run because there is no Anthropic key - the UI keys off `code`. */
export const AI_NOT_CONFIGURED_MESSAGE = "AI is not configured: Assist needs ANTHROPIC_API_KEY set in Vercel.";
export const AI_NOT_CONFIGURED_CODE = "ai_not_configured";

export function isAssistConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim());
}

export function agentModel(env: Record<string, string | undefined> = process.env): string {
  return env.ANTHROPIC_AGENT_MODEL?.trim() || DEFAULT_AGENT_MODEL;
}

export function fastModel(env: Record<string, string | undefined> = process.env): string {
  return env.ANTHROPIC_FAST_MODEL?.trim() || DEFAULT_FAST_MODEL;
}

/*
 * llmClient always sends `temperature` to Anthropic (its own default is 0.1).
 * Claude Sonnet 5.5 rejects any non-default sampling value with a 400, so
 * newer models get exactly the API default (1); Haiku 4.5 and the 4.x/3.x
 * generations still accept a low temperature, which keeps the summary terse
 * and repeatable. Models newer than Sonnet 5.5 that refuse the parameter
 * altogether can't be reached through llmClient as it stands.
 */
const LOW_TEMPERATURE_MODELS = /^claude-(?:3|haiku-4|sonnet-4|opus-4-[0156](?:\D|$))/;

/** The temperature to pass llmClient for `model`: low where the API allows it, else the API default. */
export function temperatureFor(model: string, preferred = 0.2): number {
  return LOW_TEMPERATURE_MODELS.test(model) ? preferred : 1;
}
