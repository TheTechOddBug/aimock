/**
 * Pure helpers for the Cohere live drift leg: chat-model selection and
 * infra-status classification.
 *
 * Extracted from cohere.drift.ts so the selection/classification logic is
 * unit-testable WITHOUT live credentials (the live describe block is
 * credential-gated and cannot run locally).
 */

/** Cohere REST base URL. */
export const COHERE_BASE_URL = "https://api.cohere.com";

/**
 * Environmental HTTP statuses that indicate a provider-side condition
 * (auth / out-of-credit / rate-limit / upstream outage) rather than a real
 * API-envelope drift. Mirrors the providers.ts InfraError classification:
 * 401|403 → stale-key, 429 → rate-limited, 5xx → infra-transient; 402 →
 * out-of-credit.
 *
 * The live leg converts these to an HONEST SKIP so a transient provider-side
 * condition never quarantines the drift collector and reds the PR. A real
 * shape drift (a 200 response with an unexpected envelope) is NEVER skipped.
 */
export function isInfraStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429 || status >= 500;
}

/** Minimal shape of a /v1/models listing entry we depend on. */
export interface CohereModelEntry {
  name?: string;
  is_deprecated?: boolean;
  endpoints?: string[];
}

/**
 * Select a currently-valid, non-deprecated Cohere chat model from a
 * `/v1/models?endpoint=chat` listing.
 *
 * Cohere retires model IDs on a schedule (e.g. `command-r-plus` was removed
 * 2026-04-04), so a hardcoded model name is a standing 404 / quarantine risk.
 * Self-selecting from the live listing makes the leg resilient to future
 * deprecations. Prefers a stable, widely-available default when present, else
 * falls back to the first non-deprecated chat model. Returns null when the
 * listing exposes no usable chat model.
 */
export function selectCohereChatModel(models: CohereModelEntry[]): string | null {
  const names = models
    .filter((m) => typeof m.name === "string" && m.is_deprecated !== true)
    .map((m) => m.name as string);
  const preferred = ["command-a-03-2025", "command-r-08-2024", "command-r7b-12-2024"];
  return preferred.find((p) => names.includes(p)) ?? names[0] ?? null;
}
