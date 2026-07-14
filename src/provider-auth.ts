import type { RecordProviderKey } from "./types.js";

/**
 * Default marker prefix identifying a "dummy" credential that a caller sends
 * only to satisfy an SDK's non-empty API-key requirement (e.g. `sk-aimock-...`).
 * A caller credential that is absent OR begins with this prefix is treated as a
 * placeholder that aimock is free to override with its own built-in upstream key.
 * A caller credential that does NOT begin with this prefix is treated as a real
 * key and forwarded verbatim (the caller overrides aimock).
 *
 * Overridable via the `AIMOCK_DUMMY_KEY_MARKER` env var for setups that mint
 * placeholder keys under a different prefix.
 */
export const DEFAULT_DUMMY_KEY_MARKER = "sk-aimock-";

/** Resolve the active dummy-key marker, honoring the env override. */
export function getDummyKeyMarker(): string {
  const override = process.env.AIMOCK_DUMMY_KEY_MARKER;
  return override && override.length > 0 ? override : DEFAULT_DUMMY_KEY_MARKER;
}

/**
 * How a given provider carries its API credential on the wire. aimock injects
 * its built-in key using the provider's native scheme so the upstream accepts
 * it. Providers whose auth is a signed/exchanged credential (Bedrock SigV4,
 * Vertex/Azure-AD OAuth) are deliberately absent — those are NOT simple
 * bearer/api-key schemes, so aimock never rewrites their auth and always
 * forwards the caller's credential unchanged.
 */
type AuthScheme =
  | { kind: "bearer" } // Authorization: Bearer <key>
  | { kind: "x-api-key" } // x-api-key: <key>
  | { kind: "x-goog-api-key" }; // x-goog-api-key: <key>

const PROVIDER_AUTH_SCHEMES: Partial<Record<RecordProviderKey, AuthScheme>> = {
  openai: { kind: "bearer" },
  openrouter: { kind: "bearer" },
  cohere: { kind: "bearer" },
  anthropic: { kind: "x-api-key" },
  gemini: { kind: "bearer" }, // placeholder, overridden below
  "gemini-interactions": { kind: "bearer" }, // placeholder, overridden below
};

// Gemini uses Google's x-goog-api-key header scheme. Declared separately to keep
// the map above readable; both Gemini keys resolve to the same scheme.
PROVIDER_AUTH_SCHEMES.gemini = { kind: "x-goog-api-key" };
PROVIDER_AUTH_SCHEMES["gemini-interactions"] = { kind: "x-goog-api-key" };

/**
 * Case-insensitively delete a header from a forward-header map, returning the
 * value that was present (if any). Header maps preserve the original casing of
 * incoming headers, so we can't assume a canonical key.
 */
function takeHeader(headers: Record<string, string>, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  let found: string | undefined;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) {
      found = headers[key];
      delete headers[key];
    }
  }
  return found;
}

/**
 * Extract the caller's credential value for a given auth scheme from the
 * forwarded headers, if present. For bearer, strips the `Bearer ` prefix.
 */
function readCallerCredential(
  headers: Record<string, string>,
  scheme: AuthScheme,
): string | undefined {
  if (scheme.kind === "bearer") {
    const auth = headers["authorization"] ?? headers["Authorization"];
    // Fall back to a case-insensitive scan for non-standard casing.
    const raw = auth ?? scanHeader(headers, "authorization");
    if (raw === undefined) return undefined;
    const match = /^\s*Bearer\s+(.+)$/i.exec(raw);
    return match ? match[1].trim() : raw.trim();
  }
  const headerName = scheme.kind === "x-api-key" ? "x-api-key" : "x-goog-api-key";
  return scanHeader(headers, headerName);
}

/** Case-insensitive header lookup that does not mutate the map. */
function scanHeader(headers: Record<string, string>, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) return headers[key];
  }
  return undefined;
}

/**
 * Decide whether aimock should override the caller's credential with its own
 * built-in key. Override when the caller sent no credential OR sent a dummy
 * placeholder (prefixed with the active marker). A real caller key is left
 * untouched so the caller can always override aimock.
 */
function shouldOverride(callerCredential: string | undefined, marker: string): boolean {
  if (callerCredential === undefined || callerCredential.length === 0) return true;
  return callerCredential.startsWith(marker);
}

/**
 * Inject aimock's built-in upstream credential into the forwarded headers when
 * appropriate (opt-in, backward-compatible). Mutates `forwardHeaders` in place
 * and may mutate `target` (query-param schemes; none currently).
 *
 * Precedence:
 *   - No built-in key configured for this provider  → no-op (forward verbatim).
 *   - Provider not a simple bearer/api-key scheme    → no-op (Bedrock/Vertex/Azure-AD).
 *   - Caller credential absent or dummy-prefixed      → inject built-in key.
 *   - Caller credential is a real key                 → forward it unchanged.
 *
 * @param forwardHeaders headers already built by buildForwardHeaders(req)
 * @param target upstream URL (reserved for query-param auth schemes)
 * @param providerKey which provider this request is routed to
 * @param builtinKey aimock's configured key for this provider (if any)
 */
export function applyProviderAuth(
  forwardHeaders: Record<string, string>,
  target: URL,
  providerKey: RecordProviderKey,
  builtinKey: string | undefined,
): void {
  void target; // reserved for future query-param schemes (e.g. Gemini ?key=)
  if (!builtinKey) return; // feature inert for this provider

  const scheme = PROVIDER_AUTH_SCHEMES[providerKey];
  if (!scheme) return; // signed/OAuth provider — never rewrite auth

  const marker = getDummyKeyMarker();
  const callerCredential = readCallerCredential(forwardHeaders, scheme);
  if (!shouldOverride(callerCredential, marker)) return; // caller sent a real key

  // Strip any existing auth headers for this scheme (across casings) before
  // setting aimock's key, so a dummy caller key can't linger alongside ours.
  switch (scheme.kind) {
    case "bearer":
      takeHeader(forwardHeaders, "authorization");
      forwardHeaders["Authorization"] = `Bearer ${builtinKey}`;
      break;
    case "x-api-key":
      takeHeader(forwardHeaders, "x-api-key");
      forwardHeaders["x-api-key"] = builtinKey;
      break;
    case "x-goog-api-key":
      takeHeader(forwardHeaders, "x-goog-api-key");
      forwardHeaders["x-goog-api-key"] = builtinKey;
      break;
  }
}

/**
 * Read per-provider built-in keys from the environment. Returns undefined when
 * no provider key is configured so the feature stays fully inert by default.
 */
export function readProviderKeysFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Partial<Record<RecordProviderKey, string>> | undefined {
  const keys: Partial<Record<RecordProviderKey, string>> = {};
  if (env.AIMOCK_PROVIDER_OPENAI_KEY) keys.openai = env.AIMOCK_PROVIDER_OPENAI_KEY;
  if (env.AIMOCK_PROVIDER_ANTHROPIC_KEY) keys.anthropic = env.AIMOCK_PROVIDER_ANTHROPIC_KEY;
  if (env.AIMOCK_PROVIDER_GEMINI_KEY) keys.gemini = env.AIMOCK_PROVIDER_GEMINI_KEY;
  return Object.keys(keys).length > 0 ? keys : undefined;
}
