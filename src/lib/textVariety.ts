/* Appended to every draft's system prompt across followupDraft.ts,
   cpEscalation.ts, and productWaitFollowup.ts. Low-temperature, template-
   shaped instructions plus a near-deterministic sampling temperature (the
   old default) produced messages that read as interchangeable across
   different tickets - this instruction plus each module's own draft
   temperature (now ~0.7, up from 0.1) are the two levers that push back on
   that. */
export const HUMAN_VARIETY_INSTRUCTION =
  'Write like a real person having an ordinary day, not a template - vary your opening line, sentence rhythm, and word choice from one ticket to the next. Do not default to a stock opener like "Hi X, following up on..." every time; get to the point in your own words. Keep the tone calm, warm, and genuinely considerate of whoever is reading this - a client waiting on an answer or a teammate juggling their own queue - never curt, impatient, or transactional, whichever side you\'re writing to.';

/**
 * Deterministically picks one of several phrasing variants for a given seed
 * (typically an issue key, or issue key + kind) - different tickets land on
 * different variants (so a batch of fallback messages doesn't all read as
 * the same template), while the same ticket keeps picking the same variant
 * across retries within this run rather than flip-flopping. Not
 * cryptographic - just enough spread that a human skimming several of these
 * side by side (e.g. in the agent-followups review page) doesn't see the
 * same sentence structure repeated.
 */
export function pickVariant<T>(seed: string, variants: readonly T[]): T {
  if (variants.length === 0) {
    throw new Error("pickVariant requires at least one variant.");
  }

  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }

  const index = Math.abs(hash) % variants.length;
  return variants[index]!;
}
