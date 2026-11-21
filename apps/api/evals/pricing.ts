/**
 * Claude API list prices in USD per million tokens, from the pricing page:
 * https://platform.claude.com/docs/en/about-claude/pricing (Claude Opus 5.5 and Claude Sonnet 5.5
 * fetched 2026-11-07). Claude Opus 5 and Opus 4.8 are here because they can answer as server-side
 * fallbacks; their base rates are from the same page, and their cache rates follow its multipliers
 * (5-minute writes 1.25x input, reads 0.1x input).
 *
 * Cache writes are the 5-minute rate: the triage prompt's one breakpoint uses the default TTL.
 * Amazon Bedrock is priced separately by AWS and is not in this table, so a Bedrock run reports
 * no cost rather than a wrong one. Check the page before relying on a figure: prices change.
 */
import type { TokenUsage } from '../src/triage/model.js';

export const PRICING_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';

export interface Prices {
  input: number;
  cacheWrite5m: number;
  cacheRead: number;
  output: number;
}

export const ANTHROPIC_PRICES_PER_MTOK: Readonly<Record<string, Prices>> = {
  'claude-opus-5-5': { input: 4, cacheWrite5m: 5, cacheRead: 0.2, output: 20 },
  'claude-sonnet-5-5': { input: 2, cacheWrite5m: 2.5, cacheRead: 0.1, output: 10 },
  'claude-opus-5': { input: 5, cacheWrite5m: 6.25, cacheRead: 0.5, output: 25 },
  'claude-opus-4-8': { input: 5, cacheWrite5m: 6.25, cacheRead: 0.5, output: 25 },
};

/**
 * What tokens cost on the Anthropic API, or null for a model not in the table. `inputTokens` is
 * the uncached remainder only (the API reports cache reads and writes apart), so the four counts
 * add without overlap.
 */
export function costUsd(model: string, usage: TokenUsage): number | null {
  const prices = ANTHROPIC_PRICES_PER_MTOK[model];
  if (!prices) {
    return null;
  }
  return (
    (usage.inputTokens * prices.input +
      usage.cacheCreationInputTokens * prices.cacheWrite5m +
      usage.cacheReadInputTokens * prices.cacheRead +
      usage.outputTokens * prices.output) /
    1_000_000
  );
}
