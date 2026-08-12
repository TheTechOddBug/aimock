/**
 * Tests for the drift-report collector's pure functions.
 *
 * These tests import and exercise the REAL exported functions from
 * scripts/drift-report-collector.ts — NOT local reimplementations. Importing
 * the module does NOT run main(): the collector guards its entry point with an
 * `isDirectRun()` check (main() only fires under `tsx scripts/…` invocation),
 * so importing here is side-effect-free.
 *
 * The canary fixtures below are REAL vitest failure-message shapes captured by
 * running the canary / drift / infra assertions under
 * `vitest run … --reporter=json` (the capture artifacts were throwaway and are
 * not in the repo; the RED/GREEN logs are on PR #291). They
 * are NOT hand-authored: the single-glyph Unicode ellipsis `…(N)`, the
 * `AssertionError:` prefix, the leading blank line before a formatted drift
 * report, and the stack-frame layout are exactly what vitest emits.
 */

import { describe, it, expect } from "vitest";
import { formatDriftReport } from "./drift/schema.js";
import type { ShapeDiff } from "./drift/schema.js";
import {
  parseDriftBlock,
  extractProviderName,
  extractSurfaceKey,
  extractScenario,
  parseKnownModelsCanary,
  collectDriftEntries,
  computeExitCode,
  conclusionForExitCode,
  classifyUnparseableAsInfra,
  parseLiveTimeout,
  parseWSServerClose,
  isRefusalCloseCode,
  INFRA_INDICATOR_SOURCES,
  infraIndicatorSample,
  NO_GA_DELTA_ID,
  TRUNCATED_DELTA_ID,
} from "../../scripts/drift-report-collector.js";
import type {
  DriftEntry,
  QuarantineEntry,
  TimeoutEntry,
  ParsedDiff,
} from "../../scripts/drift-types.js";
import { SURFACE_REGISTRY, KNOWN_SURFACE_SLUGS, isKnownSurface } from "./drift/surface-registry.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { isBaseReportReusable, computeDelta } from "../../scripts/drift-delta.js";
import type { DriftReport } from "../../scripts/drift-types.js";

// ---------------------------------------------------------------------------
// Helpers for the A1.3 CollectResult shape ({ entries, quarantine }).
// collectDriftEntries no longer returns a bare array nor throws on unmapped /
// unparseable-not-infra failures — those are quarantined (→ exit 5).
// ---------------------------------------------------------------------------

function entriesOf(result: VitestJsonResult): DriftEntry[] {
  return collectDriftEntries(result).entries;
}

function quarantineOf(result: VitestJsonResult): QuarantineEntry[] {
  return collectDriftEntries(result).quarantine;
}

function timeoutsOf(result: VitestJsonResult): TimeoutEntry[] {
  return collectDriftEntries(result).timeouts;
}

/**
 * The exit code main() would emit for a given collect result (agUiSkipped=false).
 *
 * Forwards EVERY lane main() forwards, timeouts included. A helper that dropped
 * a lane would report an exit code the collector never emits, and every taxonomy
 * assertion routed through it would be measuring the helper.
 */
function exitCodeOf(result: VitestJsonResult): 0 | 1 | 2 | 5 | 6 {
  const { entries, quarantine, timeouts } = collectDriftEntries(result);
  const criticalCount = entries.reduce(
    (sum, e) => sum + e.diffs.filter((d) => d.severity === "critical").length,
    0,
  );
  return computeExitCode(criticalCount, quarantine.length, false, timeouts.length);
}

// ---------------------------------------------------------------------------
// Vitest JSON reporter fixture builders
// ---------------------------------------------------------------------------

interface VitestAssertion {
  status: string;
  ancestorTitles: string[];
  title: string;
  failureMessages: string[];
}

interface VitestJsonResult {
  testResults: { assertionResults: VitestAssertion[] }[];
}

function makeResult(assertions: VitestAssertion[]): VitestJsonResult {
  return { testResults: [{ assertionResults: assertions }] };
}

function makeAssertion(overrides: Partial<VitestAssertion> = {}): VitestAssertion {
  return {
    status: "failed",
    ancestorTitles: [],
    title: "test title",
    failureMessages: [],
    ...overrides,
  };
}

const SAMPLE_DIFF: ShapeDiff = {
  path: "choices[0].message.refusal",
  severity: "critical",
  issue: "LLMOCK DRIFT — field in SDK + real API but missing from mock",
  expected: "null",
  real: "null",
  mock: "<absent>",
};

const SAMPLE_DIFF_WARNING: ShapeDiff = {
  path: "choices[0].message.extra",
  severity: "warning",
  issue: "PROVIDER ADDED FIELD — in real API but not in SDK or mock",
  expected: "<absent>",
  real: "string",
  mock: "<absent>",
};

// ---------------------------------------------------------------------------
// REAL captured vitest --reporter=json failure-message fixtures.
// Captured via throwaway `*.drift.ts` capture tests run under the drift config.
// The capture files were throwaway and are not in the repo; the RED/GREEN logs
// that show these exact shapes are on PR #291.
// ---------------------------------------------------------------------------

// Canary tripped with FOUR unknown models. The printed array is truncated by
// vitest to `…(3)` (single-glyph Unicode ellipsis), but the custom assertion
// message `UNKNOWN_REALTIME_MODELS=…` carries the full list verbatim.
// NOTE (A4): the ids below are HYPOTHETICAL future models that are NOT in
// knownVoiceModelFamilies in src/__tests__/drift/voice-models.ts — so the real
// canary really could emit them as unknown. (gpt-realtime-2.1 / -2.1-mini ARE in
// that set and therefore can never appear here — the earlier fixture that used
// them was impossible.)
const CANARY_MARKER_MULTI =
  "AssertionError: UNKNOWN_REALTIME_MODELS=gpt-realtime-3,gpt-realtime-3-mini,gpt-realtime-3-preview,gpt-realtime-ultra: expected [ 'gpt-realtime-3', …(3) ] to deeply equal []\n" +
  "    at /repo/src/__tests__/drift/ws-realtime.drift.ts:108:69\n" +
  "    at file:///repo/node_modules/@vitest/runner/dist/chunk-hooks.js:155:11\n" +
  "    at processTicksAndRejections (node:internal/process/task_queues:104:5)";

// A GENUINE drift report carried inside an AssertionError. formatDriftReport
// prepends "\n", so line 0 is just "AssertionError: " and the "API DRIFT
// DETECTED" / "mismatch" markers live on LATER lines. This is a fully-formatted
// report body (parseDriftBlock parses it into one critical diff).
const GENUINE_DRIFT_WITH_STACK =
  "AssertionError: \nAPI DRIFT DETECTED: OpenAI Chat (non-streaming text)\n\n" +
  "  1. [critical] LLMOCK DRIFT — mismatch detected\n" +
  "     Path:    choices[0].message.refusal\n" +
  "     SDK:     null\n" +
  "     Real:    null\n" +
  "     Mock:    <absent>\n" +
  ": expected [ Array(1) ] to deeply equal []\n" +
  "    at /repo/src/__tests__/drift/openai-chat.drift.ts:42:30\n" +
  "    at file:///repo/node_modules/@vitest/runner/dist/chunk-hooks.js:155:11";

// A genuinely-unparseable failure whose ONLY infra token (ECONNREFUSED) sits in
// a STACK FRAME; the assertion body is neutral (no infra token, no drift
// marker). This is the A3 asymmetry surface — a raw scan would see the frame
// token and wrongly swallow the failure; a stack-stripped scan does not.
const INFRA_TOKEN_IN_STACKFRAME_ONLY =
  "AssertionError: expected 1 to be 2 // Object.is equality\n" +
  "    at ECONNREFUSED (/repo/src/__tests__/drift/some.drift.ts:8:13)\n" +
  "    at file:///repo/node_modules/@vitest/runner/dist/chunk-hooks.js:155:11";

// A genuine infra failure whose token is in the BODY (the well-behaved case).
const REAL_INFRA_BODY = "fetch failed\n    at handler (file:///repo/src/x.drift.ts:5:1)";

// CLASS 2 — the canary `hasGA`-false mode. Captured REAL from a throwaway
// `*.drift.ts` capture run under the drift config (capture file was throwaway).
// When OpenAI renames/removes the GA realtime family, the canary emits the
// NO_GA_REALTIME_MODELS= marker (symmetric to UNKNOWN_REALTIME_MODELS=) and the
// assertion fails with "expected false to be true". The collector must map this
// to a CRITICAL OpenAI-Realtime DriftEntry (exit-2), NOT crash to exit-1.
const CANARY_NO_GA_MARKER =
  "AssertionError: NO_GA_REALTIME_MODELS=gpt-foo,gpt-bar | UNKNOWN_REALTIME_MODELS=: expected false to be true // Object.is equality\n" +
  "    at /repo/src/__tests__/drift/ws-realtime.drift.ts:96:44\n" +
  "    at file:///repo/node_modules/@vitest/runner/dist/chunk-hooks.js:155:11\n" +
  "    at processTicksAndRejections (node:internal/process/task_queues:104:5)";

// CLASS 2 combined case — the run is BOTH no-GA AND carries new unknown models.
// The hasGA assertion throws first (short-circuiting the unknown-models
// assertion), so the NO_GA marker carries BOTH lists. The collector must
// preserve the unknown list (no information loss into the auto-fix prompt).
const CANARY_NO_GA_WITH_UNKNOWN =
  "AssertionError: NO_GA_REALTIME_MODELS=gpt-foo,gpt-bar | UNKNOWN_REALTIME_MODELS=gpt-realtime-99,gpt-realtime-99-mini: expected false to be true // Object.is equality\n" +
  "    at /repo/src/__tests__/drift/ws-realtime.drift.ts:96:44\n" +
  "    at file:///repo/node_modules/@vitest/runner/dist/chunk-hooks.js:155:11";

// A NO_GA marker with an empty observed list (key could not see ANY realtime
// models — still a critical signal that the GA family is unreachable/gone).
const CANARY_NO_GA_EMPTY =
  "AssertionError: NO_GA_REALTIME_MODELS= | UNKNOWN_REALTIME_MODELS=: expected false to be true // Object.is equality\n" +
  "    at /repo/src/__tests__/drift/ws-realtime.drift.ts:96:44";

// CLASS 3 — a marker-less truncated canary array. The truncation fact must
// become a boolean flag, never a prose sentinel occupying a model-id slot.
const CANARY_FALLBACK_TRUNCATED =
  "AssertionError: expected [ 'gpt-realtime-9', …(2) ] to deeply equal []\n" +
  "    at /repo/src/__tests__/drift/ws-realtime.drift.ts:108:69";

// ---------------------------------------------------------------------------
// parseDriftBlock
// ---------------------------------------------------------------------------

describe("parseDriftBlock", () => {
  it("returns null for text with no API DRIFT DETECTED header", () => {
    expect(parseDriftBlock("")).toBeNull();
    expect(parseDriftBlock("Error: AssertionError: expected true to be false")).toBeNull();
    expect(parseDriftBlock("No drift detected: OpenAI Chat (non-streaming text)")).toBeNull();
  });

  it("parses a single drift entry correctly", () => {
    const formatted = formatDriftReport("OpenAI Chat (non-streaming text)", [SAMPLE_DIFF]);
    const result = parseDriftBlock(formatted);

    expect(result).not.toBeNull();
    expect(result!.context).toBe("OpenAI Chat (non-streaming text)");
    expect(result!.diffs).toHaveLength(1);

    const diff = result!.diffs[0];
    expect(diff.severity).toBe("critical");
    expect(diff.path).toBe("choices[0].message.refusal");
    expect(diff.issue).toBe("LLMOCK DRIFT — field in SDK + real API but missing from mock");
    expect(diff.expected).toBe("null");
    expect(diff.real).toBe("null");
    expect(diff.mock).toBe("<absent>");
  });

  it("parses multiple drift entries", () => {
    const formatted = formatDriftReport("OpenAI Chat (non-streaming text)", [
      SAMPLE_DIFF,
      SAMPLE_DIFF_WARNING,
    ]);
    const result = parseDriftBlock(formatted);

    expect(result).not.toBeNull();
    expect(result!.diffs).toHaveLength(2);
    expect(result!.diffs[0].severity).toBe("critical");
    expect(result!.diffs[1].severity).toBe("warning");
    expect(result!.diffs[1].path).toBe("choices[0].message.extra");
  });

  it("skips entries with unknown severity", () => {
    const text = `
API DRIFT DETECTED: OpenAI Chat (test)

  1. [unknown] Some issue
     Path:    foo.bar
     SDK:     string
     Real:    string
     Mock:    <absent>

  2. [critical] Real issue
     Path:    baz.qux
     SDK:     null
     Real:    null
     Mock:    <absent>
`;
    const result = parseDriftBlock(text);
    expect(result).not.toBeNull();
    expect(result!.diffs).toHaveLength(1);
    expect(result!.diffs[0].severity).toBe("critical");
    expect(result!.diffs[0].path).toBe("baz.qux");
  });

  it("handles context strings with parenthetical scenario", () => {
    const formatted = formatDriftReport("Anthropic Claude (streaming tool call)", [SAMPLE_DIFF]);
    const result = parseDriftBlock(formatted);

    expect(result).not.toBeNull();
    expect(result!.context).toBe("Anthropic Claude (streaming tool call)");
  });

  it("round-trips through formatDriftReport for all severity levels", () => {
    const diffs: ShapeDiff[] = [
      { ...SAMPLE_DIFF, severity: "critical" },
      { ...SAMPLE_DIFF_WARNING, severity: "warning" },
      {
        path: "model",
        severity: "info",
        issue: "SDK EXTRA — field in SDK but not in real API response",
        expected: "string",
        real: "<absent>",
        mock: "string",
      },
    ];
    const formatted = formatDriftReport("Google Gemini (non-streaming text)", diffs);
    const result = parseDriftBlock(formatted);

    expect(result).not.toBeNull();
    expect(result!.context).toBe("Google Gemini (non-streaming text)");
    expect(result!.diffs).toHaveLength(3);

    for (let i = 0; i < diffs.length; i++) {
      expect(result!.diffs[i].severity).toBe(diffs[i].severity);
      expect(result!.diffs[i].path).toBe(diffs[i].path);
      expect(result!.diffs[i].issue).toBe(diffs[i].issue);
      expect(result!.diffs[i].expected).toBe(diffs[i].expected);
      expect(result!.diffs[i].real).toBe(diffs[i].real);
      expect(result!.diffs[i].mock).toBe(diffs[i].mock);
    }
  });
});

// ---------------------------------------------------------------------------
// extractProviderName
// ---------------------------------------------------------------------------

describe("extractProviderName", () => {
  it("matches exact provider names", () => {
    expect(extractProviderName("OpenAI Chat")).toBe("OpenAI Chat");
    expect(extractProviderName("Gemini")).toBe("Gemini");
    expect(extractProviderName("OpenAI Realtime")).toBe("OpenAI Realtime");
  });

  it("uses longest match — Anthropic Claude over Anthropic", () => {
    expect(extractProviderName("Anthropic Claude drift")).toBe("Anthropic Claude");
    expect(extractProviderName("Anthropic Claude (streaming tool call)")).toBe("Anthropic Claude");
  });

  it("uses longest match — Google Gemini over Gemini", () => {
    expect(extractProviderName("Google Gemini drift")).toBe("Google Gemini");
    expect(extractProviderName("Google Gemini (non-streaming text)")).toBe("Google Gemini");
  });

  it("returns null for unknown provider", () => {
    expect(extractProviderName("")).toBeNull();
    expect(extractProviderName("Unknown Provider drift")).toBeNull();
    expect(extractProviderName("Cohere drift")).toBeNull();
  });

  it("matches provider in drift test describe block format", () => {
    expect(extractProviderName("OpenAI Chat Completions drift")).toBe("OpenAI Chat");
    expect(extractProviderName("OpenAI Responses API drift")).toBe("OpenAI Responses");
    expect(extractProviderName("Gemini Live WebSocket drift")).toBe("Gemini Live");
  });

  it("matches provider from context string (parenthetical format)", () => {
    expect(extractProviderName("OpenAI Chat (non-streaming text)")).toBe("OpenAI Chat");
    expect(extractProviderName("Anthropic (streaming text)")).toBe("Anthropic");
  });

  // A label appearing ANYWHERE in the text used to win on length alone, so a
  // qualifier later in the title could outrank the surface the title is actually
  // about: "Gemini Live Transcription session" resolved to `Transcription`
  // (13 chars) over `Gemini Live` (11), silently routing a Gemini Live drift at
  // src/transcription.ts. It failed OPEN — a confident wrong attribution, no
  // error. Both `parsed.context` (`formatDriftReport`'s "<Provider> (<scenario>)")
  // and a drift describe title LEAD with the provider label, so the match is now
  // anchored at the start.
  it("does not let a later qualifier outrank the leading provider label", () => {
    expect(extractProviderName("Gemini Live Transcription session")).toBe("Gemini Live");
    expect(extractProviderName("Gemini Live Transcription drift")).toBe("Gemini Live");
    expect(extractProviderName("OpenAI Video Transcription drift")).toBe("OpenAI Video");
    // …and the label that legitimately leads still resolves to itself.
    expect(extractProviderName("Transcription (whisper-1 verbose_json)")).toBe("Transcription");
  });

  it("fails closed when the provider label is not the leading token", () => {
    // Not anchored → unattributable → null, which routes the block to the
    // quarantine lane (exit 5, human review) rather than to a fabricated owner.
    expect(extractProviderName("drift detected in OpenAI Chat")).toBeNull();
    expect(extractProviderName("session for Gemini Live")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractScenario
// ---------------------------------------------------------------------------

describe("extractScenario", () => {
  it("extracts the parenthetical scenario", () => {
    expect(extractScenario("OpenAI Chat (non-streaming text)")).toBe("non-streaming text");
    expect(extractScenario("Anthropic Claude (streaming tool call)")).toBe("streaming tool call");
  });

  it("returns the whole context when there is no parenthetical", () => {
    expect(extractScenario("OpenAI Chat")).toBe("OpenAI Chat");
  });
});

// ---------------------------------------------------------------------------
// collectDriftEntries (HTTP drift path)
// ---------------------------------------------------------------------------

describe("collectDriftEntries", () => {
  it("returns empty entries+quarantine when no failed tests", () => {
    const result = makeResult([
      makeAssertion({ status: "passed" }),
      makeAssertion({ status: "pending" }),
    ]);
    expect(entriesOf(result)).toEqual([]);
    expect(quarantineOf(result)).toEqual([]);
    expect(exitCodeOf(result)).toBe(0);
  });

  it("returns empty entries+quarantine when there are no test files at all", () => {
    const result: VitestJsonResult = { testResults: [] };
    expect(entriesOf(result)).toEqual([]);
    expect(quarantineOf(result)).toEqual([]);
  });

  it("QUARANTINES (does NOT throw) an unmapped provider found in a drift report → exit 5", () => {
    // A1.3: an unmapped provider is untrusted, not a collector crash. It is held
    // for review (exit 5) instead of throwing (was exit 1).
    const driftText = formatDriftReport("UnknownProvider (non-streaming text)", [SAMPLE_DIFF]);
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["UnknownProvider drift"],
        failureMessages: [driftText],
      }),
    ]);
    expect(() => collectDriftEntries(result)).not.toThrow();
    const q = quarantineOf(result);
    expect(q).toHaveLength(1);
    expect(entriesOf(result)).toEqual([]);
    expect(exitCodeOf(result)).toBe(5);
  });

  it("QUARANTINES (does NOT throw) all-unparseable-not-infra failures → exit 5 (incident-5)", () => {
    // A1.3: the incident-5 surface. Genuine-but-unparseable failures are no
    // longer a fail-loud crash (exit 1) — they are quarantined (exit 5) so they
    // surface for review without being swallowed.
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["Some Suite"],
        title: "a",
        failureMessages: [
          "AssertionError: expected 1 to be 2 // Object.is equality\n    at foo (/repo/src/__tests__/drift/some.drift.ts:8:13)",
        ],
      }),
      makeAssertion({
        status: "failed",
        ancestorTitles: ["Other Suite"],
        title: "b",
        failureMessages: [
          "TypeError: Cannot read property 'foo' of undefined\n    at bar (/repo/src/__tests__/drift/other.drift.ts:3:1)",
        ],
      }),
    ]);
    expect(() => collectDriftEntries(result)).not.toThrow();
    const q = quarantineOf(result);
    expect(q).toHaveLength(2);
    // O-1: raw file:line captured from the stack frame BEFORE stripping.
    expect(q[0].rawLocation).toBe("/repo/src/__tests__/drift/some.drift.ts:8:13");
    expect(q[1].rawLocation).toBe("/repo/src/__tests__/drift/other.drift.ts:3:1");
    expect(entriesOf(result)).toEqual([]);
    expect(exitCodeOf(result)).toBe(5);
  });

  it("recognizes an OpenAI Realtime WS handshake failure as a critical DriftEntry (exit 2), NOT an opaque exit-5 quarantine", () => {
    // REAL vitest failure-message shape captured from the drift-live-pr CI run
    // that surfaced the GA session.type protocol change: the socket upgraded,
    // the live API returned ONE `error` event, then the probe timed out waiting
    // for session.updated. Before the WS-handshake recognizer this fell through
    // to exit-5 quarantine (opaque red); now it is a parseable critical drift.
    const wsHandshakeFailure =
      "Error: waitUntil timeout after 30000ms. Collected 1 messages: [error] " +
      'bodies=[{"type":"error","event_id":"event_E4b9BfUiVmC9qkIgQZSni",' +
      '"error":{"type":"invalid_request_error","code":"missing_required_parameter",' +
      '"message":"Missing required parameter: \'session.type\'.","param":"session.type"}}]\n' +
      "    at openaiRealtimeWS (/repo/src/__tests__/drift/ws-providers.ts:214:23)\n" +
      "    at /repo/src/__tests__/drift/ws-realtime.drift.ts:138:26";
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Realtime API drift"],
        title: "WS text event sequence and shapes match (GA)",
        failureMessages: [wsHandshakeFailure],
      }),
    ]);

    // GREEN: one attributed critical entry, no quarantine, exit 2.
    expect(quarantineOf(result)).toEqual([]);
    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);
    expect(entries[0].provider).toBe("OpenAI Realtime");
    expect(entries[0].builderFile).toBe("src/ws-realtime.ts");
    expect(entries[0].diffs).toHaveLength(1);
    expect(entries[0].diffs[0].severity).toBe("critical");
    // The surfaced error payload (type/code/message) is carried into the entry.
    expect(entries[0].diffs[0].real).toContain("invalid_request_error");
    expect(entries[0].diffs[0].issue).toContain("missing_required_parameter");
    expect(entries[0].diffs[0].issue).toContain("session.type");
    expect(exitCodeOf(result)).toBe(2);
  });

  it("does NOT recognize a bare WS timeout (zero messages, no error body) as handshake drift → live-timeout lane (exit 6), NOT drift and NOT quarantine", () => {
    // A zero-observation timeout carries no provider `error` body, so it must NOT
    // be reclassified as protocol drift. Nor is it unparseable: the message states
    // the wait budget and that zero messages arrived. It lands in the live-timeout
    // lane (exit 6) — see parseLiveTimeout.
    const bareTimeout =
      "Error: waitUntil timeout after 30000ms. Collected 0 messages: []\n" +
      "    at openaiRealtimeWS (/repo/src/__tests__/drift/ws-providers.ts:372:20)\n" +
      "    at /repo/src/__tests__/drift/ws-realtime.drift.ts:138:26";
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Realtime API drift"],
        title: "WS text event sequence and shapes match (GA)",
        failureMessages: [bareTimeout],
      }),
    ]);
    expect(entriesOf(result)).toEqual([]);
    expect(quarantineOf(result)).toEqual([]);
    expect(timeoutsOf(result)).toHaveLength(1);
    expect(exitCodeOf(result)).toBe(6);
  });

  it("returns valid entries and tolerates unparseable failures mixed in", () => {
    const driftText = formatDriftReport("OpenAI Chat (non-streaming text)", [SAMPLE_DIFF]);
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Chat Completions drift"],
        title: "non-streaming text matches real API",
        failureMessages: [driftText],
      }),
      makeAssertion({
        status: "failed",
        ancestorTitles: ["unrelated suite"],
        title: "some other failure",
        failureMessages: ["Error: plain error with no drift header"],
      }),
    ]);

    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);
    expect(entries[0].provider).toBe("OpenAI Chat");
    expect(entries[0].scenario).toBe("non-streaming text");
    expect(entries[0].builderFile).toBe("src/helpers.ts");
    expect(entries[0].diffs).toHaveLength(1);
    expect(entries[0].diffs[0].severity).toBe("critical");
    // When real drift entries ARE present, a mixed-in unparseable sibling stays
    // TOLERATED (warn-only) rather than quarantined — the quarantine path only
    // fires for the all-unparseable, zero-entries case (former throw site).
    expect(quarantineOf(result)).toEqual([]);
    // A critical entry present → exit 2 (dominates any tolerated sibling).
    expect(exitCodeOf(result)).toBe(2);
  });

  it("ignores passed assertions in a mixed result set", () => {
    const driftText = formatDriftReport("OpenAI Chat (non-streaming text)", [SAMPLE_DIFF]);
    const result = makeResult([
      makeAssertion({ status: "passed", failureMessages: [] }),
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Chat Completions drift"],
        title: "non-streaming text matches real API",
        failureMessages: [driftText],
      }),
    ]);

    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);
    expect(entries[0].provider).toBe("OpenAI Chat");
  });

  it("collects entries from multiple test files", () => {
    const openAiDrift = formatDriftReport("OpenAI Chat (non-streaming text)", [SAMPLE_DIFF]);
    const geminiDrift = formatDriftReport("Google Gemini (non-streaming text)", [
      SAMPLE_DIFF_WARNING,
    ]);

    const results: VitestJsonResult = {
      testResults: [
        {
          assertionResults: [
            makeAssertion({
              status: "failed",
              ancestorTitles: ["OpenAI Chat Completions drift"],
              failureMessages: [openAiDrift],
            }),
          ],
        },
        {
          assertionResults: [
            makeAssertion({
              status: "failed",
              ancestorTitles: ["Google Gemini drift"],
              failureMessages: [geminiDrift],
            }),
          ],
        },
      ],
    };

    const entries = entriesOf(results);
    expect(entries).toHaveLength(2);
    expect(entries[0].provider).toBe("OpenAI Chat");
    expect(entries[1].provider).toBe("Google Gemini");
  });

  // -------------------------------------------------------------------------
  // INTEGRATION: the canary → critical → exit-2 contract, end to end through
  // the REAL collectDriftEntries. This is the whole reason PR #291 exists.
  // -------------------------------------------------------------------------

  it("emits ONE critical DriftEntry carrying the FULL unknown-model list from a real canary failure (RED without the marker fix)", () => {
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Realtime API drift"],
        title: "canary: GA realtime models available",
        failureMessages: [CANARY_MARKER_MULTI],
      }),
    ]);

    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.provider).toBe("OpenAI Realtime");
    expect(entry.scenario).toBe("known-models canary");
    expect(entry.builderFile).toBe("src/ws-realtime.ts");

    // FULL list recovered from the marker (NOT truncated to just the first id).
    const reals = entry.diffs.map((d) => d.real);
    expect(reals).toEqual([
      "gpt-realtime-3",
      "gpt-realtime-3-mini",
      "gpt-realtime-3-preview",
      "gpt-realtime-ultra",
    ]);

    // Every diff is critical so the collector exits 2 and the Fix Drift
    // workflow reaches the auto-fix step.
    expect(entry.diffs.every((d) => d.severity === "critical")).toBe(true);
    // Real-API-only canary: the model id must NOT be mislabeled as a mock value.
    for (const d of entry.diffs) {
      expect(d.mock).not.toBe(d.real);
      expect(d.mock).toContain("no mock leg");
    }

    // The exit-2 gate condition (criticalCount > 0) that main() checks.
    const criticalCount = entries.reduce(
      (sum, e) => sum + e.diffs.filter((d) => d.severity === "critical").length,
      0,
    );
    expect(criticalCount).toBe(4);
  });

  it("does NOT misattribute a non-canary toEqual([]) failure from another provider as OpenAI-Realtime drift → quarantine (exit 5)", () => {
    // A different provider's test failed with the generic vitest shape
    // `expected [ 'sk-leaked' ] to deeply equal []`. Pre-fix, the unguarded
    // canary fallback matched this and emitted a CRITICAL "OpenAI Realtime
    // known-models canary" entry with `real: 'sk-leaked'`, pointing the auto-fix
    // at src/ws-realtime.ts and relabeling arbitrary array contents as a model
    // id. It must NOT be claimed as a canary. A1.3: because the message is
    // neither a parseable drift block, a canary, nor infra, it is QUARANTINED
    // (exit 5) — never fabricated into a false entry, never silently dropped,
    // and (A1.3) no longer a fail-loud crash.
    const NON_CANARY_TOEQUAL_EMPTY =
      "AssertionError: expected [ 'sk-leaked' ] to deeply equal []\n" +
      "    at /repo/src/__tests__/drift/openai-chat.drift.ts:42:30\n" +
      "    at file:///repo/node_modules/@vitest/runner/dist/chunk-hooks.js:155:11";
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Chat Completions drift"],
        title: "non-streaming text matches real API",
        failureMessages: [NON_CANARY_TOEQUAL_EMPTY],
      }),
    ]);

    expect(() => collectDriftEntries(result)).not.toThrow();
    // No OpenAI-Realtime (nor any) entry may be produced.
    expect(entriesOf(result)).toEqual([]);
    expect(quarantineOf(result)).toHaveLength(1);
    // The arbitrary array content is NOT relabeled as a model id anywhere.
    expect(quarantineOf(result)[0].message).toContain("sk-leaked");
    expect(exitCodeOf(result)).toBe(5);
  });

  it("surfaces a genuine drift report carried in an AssertionError with a leading blank line (does not swallow)", () => {
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Chat Completions drift"],
        title: "non-streaming text matches real API",
        failureMessages: [GENUINE_DRIFT_WITH_STACK],
      }),
    ]);

    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);
    expect(entries[0].provider).toBe("OpenAI Chat");
    expect(entries[0].diffs).toHaveLength(1);
    expect(entries[0].diffs[0].severity).toBe("critical");
  });

  it("does NOT exit 0 (quarantines → exit 5) when the only failure has an infra token confined to a stack frame (A3)", () => {
    // The raw-vs-stripped asymmetry classified this as benign infra and swallowed
    // it (returned []). The fix normalizes both scans, so an infra token that
    // survives ONLY in a stripped-away stack frame no longer flips the gate — the
    // failure is surfaced. A1.3: surfaced now means QUARANTINE (exit 5), not a
    // crash; the invariant that matters is it is NEVER a green (exit 0).
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Realtime API drift"],
        title: "canary: GA realtime models available",
        failureMessages: [INFRA_TOKEN_IN_STACKFRAME_ONLY],
      }),
    ]);
    expect(() => collectDriftEntries(result)).not.toThrow();
    expect(quarantineOf(result)).toHaveLength(1);
    expect(exitCodeOf(result)).toBe(5);
    expect(exitCodeOf(result)).not.toBe(0);
  });

  // -------------------------------------------------------------------------
  // CLASS 2 — hasGA-false canary maps to a CRITICAL OpenAI-Realtime entry
  // (exit-2 path) instead of crashing to exit-1.
  // -------------------------------------------------------------------------
  it("maps a NO_GA_REALTIME_MODELS canary failure to a CRITICAL OpenAI-Realtime entry (exit-2, not a throw)", () => {
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Realtime API drift"],
        title: "canary: GA realtime models available",
        failureMessages: [CANARY_NO_GA_MARKER],
      }),
    ]);

    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.provider).toBe("OpenAI Realtime");
    expect(entry.builderFile).toBe("src/ws-realtime.ts");
    expect(entry.diffs.length).toBeGreaterThan(0);
    expect(entry.diffs.every((d) => d.severity === "critical")).toBe(true);

    const criticalCount = entries.reduce(
      (sum, e) => sum + e.diffs.filter((d) => d.severity === "critical").length,
      0,
    );
    expect(criticalCount).toBeGreaterThan(0);
  });

  it("preserves the unknown-model list in the NO_GA entry (no info loss when both fire)", () => {
    // A run that is BOTH no-GA AND has new unknown models must surface the
    // unknown ids as critical diffs, not lose them to the short-circuited
    // unknown-models assertion.
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Realtime API drift"],
        title: "canary: GA realtime models available",
        failureMessages: [CANARY_NO_GA_WITH_UNKNOWN],
      }),
    ]);
    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.provider).toBe("OpenAI Realtime");
    expect(entry.diffs.every((d) => d.severity === "critical")).toBe(true);
    // The unknown model ids survive as `real` values on the
    // knownVoiceModelFamilies diffs.
    const knownModelReals = entry.diffs
      .filter((d) => d.path === "knownVoiceModelFamilies")
      .map((d) => d.real);
    expect(knownModelReals).toEqual(["gpt-realtime-99", "gpt-realtime-99-mini"]);
    // The GA-family diff is still present.
    expect(entry.diffs.some((d) => d.path === "gaRealtimeModels")).toBe(true);
  });

  it("maps an EMPTY NO_GA marker (no realtime models observed) to a CRITICAL entry too", () => {
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Realtime API drift"],
        title: "canary: GA realtime models available",
        failureMessages: [CANARY_NO_GA_EMPTY],
      }),
    ]);
    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);
    expect(entries[0].provider).toBe("OpenAI Realtime");
    expect(entries[0].diffs.every((d) => d.severity === "critical")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // CLASS 3 — no DriftEntry.real is a non-model prose sentinel, even when the
  // canary array was truncated in CI output.
  // -------------------------------------------------------------------------
  it("never lands a prose sentinel in DriftEntry.real when the canary array is truncated (CLASS 3)", () => {
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Realtime API drift"],
        title: "canary: GA realtime models available",
        failureMessages: [CANARY_FALLBACK_TRUNCATED],
      }),
    ]);
    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);
    for (const d of entries[0].diffs) {
      // No `real` value may be a prose annotation (e.g. "(additional models…)").
      expect(d.real.startsWith("(")).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // CLASS 1 — corpus/table test asserting the SAFE outcome for the recurring
  // classifier failure shapes. A1.3 replaces the old binary throws/no-throw
  // with a three-way `outcome`:
  //   "entry"      → surfaced as a structured drift entry (exit 2), NEVER a
  //                  silent exit-0;
  //   "quarantine" → held for human review (exit 5), NEVER a crash and NEVER a
  //                  silent exit-0 (was: fail-loud throw / exit 1);
  //   "infra"      → benign infra, collector returns [] (exit 0).
  // The invariant the corpus protects: an untrusted failure is never a green.
  // -------------------------------------------------------------------------
  describe("CLASS 1 safe-outcome corpus", () => {
    const DRIFT_VALUE_WITH_STATUS_200 = formatDriftReport("OpenAI Chat (non-streaming text)", [
      {
        path: "choices[0].message.content",
        severity: "critical",
        issue: "LLMOCK DRIFT — value mismatch",
        expected: "status 200",
        real: "status 200",
        mock: "<absent>",
      },
    ]);

    const rows: {
      name: string;
      messages: string[];
      outcome: "entry" | "quarantine" | "infra";
    }[] = [
      {
        name: "a drift body containing the substring 'status 200' is surfaced as an entry, NOT swallowed as infra",
        messages: [DRIFT_VALUE_WITH_STATUS_200],
        outcome: "entry",
      },
      {
        name: "a genuine drift report with a leading blank line is surfaced as an entry",
        messages: [GENUINE_DRIFT_WITH_STACK],
        outcome: "entry",
      },
      {
        name: "an 'expected false to be true' hasGA shape is surfaced as a (canary) entry, not swallowed",
        messages: [CANARY_NO_GA_MARKER],
        outcome: "entry",
      },
      {
        name: "an 'expected […] to deeply equal []' canary shape is surfaced as an entry, not swallowed",
        messages: [CANARY_MARKER_MULTI],
        outcome: "entry",
      },
      {
        name: "a bare AssertionError with no infra token and no drift marker is quarantined (exit 5), not swallowed",
        messages: ["AssertionError: expected 1 to be 2 // Object.is equality\n    at foo (x:1:1)"],
        outcome: "quarantine",
      },
      {
        name: "an infra token confined to a stack frame is quarantined (exit 5) (A3)",
        messages: [INFRA_TOKEN_IN_STACKFRAME_ONLY],
        outcome: "quarantine",
      },
    ];

    for (const row of rows) {
      it(row.name, () => {
        const result = makeResult(
          row.messages.map((m) =>
            makeAssertion({
              status: "failed",
              ancestorTitles: ["OpenAI Realtime API drift"],
              title: "canary: GA realtime models available",
              failureMessages: [m],
            }),
          ),
        );
        expect(() => collectDriftEntries(result)).not.toThrow();
        const { entries, quarantine } = collectDriftEntries(result);
        if (row.outcome === "entry") {
          expect(entries.length).toBeGreaterThan(0);
          expect(exitCodeOf(result)).toBe(2);
        } else if (row.outcome === "quarantine") {
          expect(entries).toEqual([]);
          expect(quarantine.length).toBeGreaterThan(0);
          expect(exitCodeOf(result)).toBe(5);
          expect(exitCodeOf(result)).not.toBe(0);
        } else {
          expect(entries).toEqual([]);
          expect(quarantine).toEqual([]);
          expect(exitCodeOf(result)).toBe(0);
        }
      });
    }

    it("still classifies genuine infra (body token) as benign — collector returns [] entries+quarantine (exit 0)", () => {
      const result = makeResult([
        makeAssertion({
          status: "failed",
          ancestorTitles: ["OpenAI Chat Completions drift"],
          title: "non-streaming text matches real API",
          failureMessages: [REAL_INFRA_BODY],
        }),
      ]);
      expect(entriesOf(result)).toEqual([]);
      expect(quarantineOf(result)).toEqual([]);
      expect(exitCodeOf(result)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // A1.4 TAXONOMY — the exit-code taxonomy end-to-end through the REAL collector
  // + computeExitCode. Each row asserts the full path from a vitest failure
  // shape to the process exit code main() would emit.
  // -------------------------------------------------------------------------
  describe("exit-code taxonomy (collector → computeExitCode)", () => {
    it("critical drift → exit 2", () => {
      const driftText = formatDriftReport("OpenAI Chat (non-streaming text)", [SAMPLE_DIFF]);
      const result = makeResult([
        makeAssertion({
          status: "failed",
          ancestorTitles: ["OpenAI Chat Completions drift"],
          failureMessages: [driftText],
        }),
      ]);
      expect(entriesOf(result)).toHaveLength(1);
      expect(quarantineOf(result)).toEqual([]);
      expect(exitCodeOf(result)).toBe(2);
    });

    it("incident-5 unparseable failure → quarantine + exit 5 (NOT a throw)", () => {
      const result = makeResult([
        makeAssertion({
          status: "failed",
          ancestorTitles: ["Broken Suite"],
          title: "a",
          failureMessages: [
            "AssertionError: expected 1 to be 2 // Object.is equality\n    at foo (/repo/src/__tests__/drift/x.drift.ts:8:13)",
          ],
        }),
      ]);
      expect(() => collectDriftEntries(result)).not.toThrow();
      expect(entriesOf(result)).toEqual([]);
      expect(quarantineOf(result)).toHaveLength(1);
      expect(exitCodeOf(result)).toBe(5);
    });

    it("all-infra failures → exit 0 (benign, collector returns nothing)", () => {
      const result = makeResult([
        makeAssertion({
          status: "failed",
          ancestorTitles: ["OpenAI Chat Completions drift"],
          failureMessages: [REAL_INFRA_BODY],
        }),
        makeAssertion({
          status: "failed",
          ancestorTitles: ["OpenAI Responses drift"],
          failureMessages: [
            "INFRA_ERROR: upstream down\n    at h (file:///repo/src/y.drift.ts:1:1)",
          ],
        }),
      ]);
      expect(entriesOf(result)).toEqual([]);
      expect(quarantineOf(result)).toEqual([]);
      expect(exitCodeOf(result)).toBe(0);
    });

    it("F1: a benign infra leg is NOT batch-poisoned into quarantine by an unparseable sibling (per-leg classification)", () => {
      // The recurring session failure: one leg emits genuinely-unparseable output
      // in the SAME run as sibling legs that failed on benign infra (network
      // flake). Pre-fix, the all-or-nothing classifyUnparseableAsInfra gate saw a
      // MIXED batch (not EVERY message is infra) and quarantined EVERY unparseable
      // failure — dragging the benign infra leg into the shared base report's
      // quarantine (exit 5) and poisoning it for every downstream PR. Per-leg
      // classification swallows the infra leg on its own and quarantines ONLY the
      // genuinely-unparseable leg.
      const result = makeResult([
        // Leg A: benign infra (network flake) — swallowed on its own merits.
        makeAssertion({
          status: "failed",
          ancestorTitles: ["OpenAI Chat Completions drift"],
          title: "non-streaming text matches real API",
          failureMessages: [REAL_INFRA_BODY],
        }),
        // Leg B: genuinely unparseable (no infra token) — legitimately quarantined.
        makeAssertion({
          status: "failed",
          ancestorTitles: ["Broken Suite"],
          title: "unrecognized",
          failureMessages: [
            "AssertionError: expected 1 to be 2\n    at foo (/repo/src/__tests__/drift/b.drift.ts:1:1)",
          ],
        }),
      ]);
      const { entries, quarantine } = collectDriftEntries(result);
      expect(entries).toEqual([]);
      // GREEN: exactly ONE quarantine entry — leg B only; leg A (infra) swallowed.
      // RED pre-fix: quarantine.length === 2 (leg A poisoned in alongside leg B).
      expect(quarantine).toHaveLength(1);
      expect(quarantine[0].testName).toContain("unrecognized");
      // The genuinely-unparseable leg still legitimately reds the run (exit 5) —
      // real drift/quarantine detection is NOT weakened.
      expect(exitCodeOf(result)).toBe(5);
    });

    it("canary (unknown-model) failure → critical entry + exit 2", () => {
      const result = makeResult([
        makeAssertion({
          status: "failed",
          ancestorTitles: ["OpenAI Realtime API drift"],
          title: "canary: GA realtime models available",
          failureMessages: [CANARY_MARKER_MULTI],
        }),
      ]);
      const entries = entriesOf(result);
      expect(entries).toHaveLength(1);
      expect(entries[0].diffs.every((d) => d.severity === "critical")).toBe(true);
      expect(exitCodeOf(result)).toBe(2);
    });

    it("empty → fail-loud invariant: an all-unparseable batch is NEVER classified as a benign all-clear", () => {
      // CLASS 1 root invariant surfaced at the collector: an empty evidence set
      // (no positive infra evidence) must NOT be treated as infra. The batch is
      // quarantined (exit 5), never a silent exit 0.
      expect(classifyUnparseableAsInfra([])).toBe(false);
      const result = makeResult([
        makeAssertion({
          status: "failed",
          ancestorTitles: ["Broken Suite"],
          title: "unrecognized",
          failureMessages: [
            "AssertionError: expected 1 to be 2\n    at foo (/repo/src/z.drift.ts:1:1)",
          ],
        }),
      ]);
      expect(exitCodeOf(result)).not.toBe(0);
      expect(exitCodeOf(result)).toBe(5);
    });

    it("critical + quarantine together → exit 2 (critical dominates quarantine)", () => {
      const driftText = formatDriftReport("OpenAI Chat (non-streaming text)", [SAMPLE_DIFF]);
      const result = makeResult([
        makeAssertion({
          status: "failed",
          ancestorTitles: ["OpenAI Chat Completions drift"],
          title: "non-streaming text matches real API",
          failureMessages: [driftText],
        }),
        // An unmapped-provider drift block → quarantined (never dropped) even
        // though a real critical entry is also present.
        makeAssertion({
          status: "failed",
          ancestorTitles: ["UnknownProvider drift"],
          title: "some scenario",
          failureMessages: [formatDriftReport("UnknownProvider (streaming text)", [SAMPLE_DIFF])],
        }),
      ]);
      const { entries, quarantine } = collectDriftEntries(result);
      expect(entries).toHaveLength(1);
      expect(entries[0].provider).toBe("OpenAI Chat");
      expect(quarantine).toHaveLength(1);
      // Critical dominates: exit 2, not 5.
      expect(exitCodeOf(result)).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// An empty field value must not eat the next entry
//
// `compareShapes` sets `mock: ""` on every diff it produces, and the entry regex
// used `Mock:\s*(.+)`. `\s` matches newlines, so on an empty value the greedy
// `\s*` ran past the end of its own line and `(.+)` matched the NEXT ENTRY'S
// header, consuming it whole. When the swallowed entry was the critical one,
// `criticalCount` fell to 0 and the collector reported `conclusion: "clean"` —
// the failure state and the working state were observationally identical, which
// is the worst shape a defect can have here.
//
// SCOPE, measured rather than assumed: the trigger is ONE empty-`mock` entry that
// has a successor. It is NOT limited to consecutive empty values (a block whose
// only empty value sits in the middle loses its THIRD entry), and a trailing
// empty-`mock` entry survives (the capture falls back to the value's own trailing
// spaces). Two live surfaces emit compareShapes-derived blocks —
// `fal-queue.drift.ts` and `video.drift.ts` — where the value is empty on 100% of
// diffs, so a block of N entries lost floor(N/2) of them.
//
// The round-trip property below is the non-recurring part: it asserts through the
// REAL emitter and the REAL parser that what a block PRINTS is what the collector
// COLLECTS, across every empty/filled permutation. Any future separator that can
// cross a newline fails it without anyone having to think of this case again.
// ---------------------------------------------------------------------------

describe("what a drift block prints is what the collector collects", () => {
  const diff = (
    n: number,
    mock: string,
    severity: ShapeDiff["severity"] = "warning",
  ): ShapeDiff => ({
    path: `field${n}`,
    severity,
    issue: `issue ${n}`,
    expected: "e",
    real: "r",
    mock,
  });
  const EMPTY = "";
  const FILLED = "<absent>";

  // Every permutation of empty/filled `mock` up to 3 entries, plus the 4-entry
  // all-empty case that shows the loss compounding.
  const permutations: string[][] = [
    [EMPTY],
    [FILLED],
    [EMPTY, EMPTY],
    [EMPTY, FILLED],
    [FILLED, EMPTY],
    [FILLED, FILLED],
    [EMPTY, EMPTY, EMPTY],
    [FILLED, EMPTY, FILLED],
    [EMPTY, FILLED, EMPTY],
    [EMPTY, EMPTY, EMPTY, EMPTY],
  ];

  it.each(permutations.map((m) => [m.map((x) => (x === EMPTY ? "empty" : "filled")).join("+"), m]))(
    "round-trips every entry when the mock values are %s",
    (_label, mocks) => {
      const diffs = (mocks as string[]).map((m, i) => diff(i + 1, m));
      const parsed = parseDriftBlock(formatDriftReport("Round-trip probe", diffs));
      expect(parsed).not.toBeNull();
      // Path is the identity here, so a swallowed entry shows up as a missing path
      // rather than as a count that happens to match for the wrong reason.
      expect(parsed!.diffs.map((d) => d.path)).toEqual(diffs.map((d) => d.path));
      expect(parsed!.diffs.map((d) => d.mock)).toEqual(diffs.map((d) => d.mock));
    },
  );

  it("a critical diff behind an empty-mock entry survives to the exit code", () => {
    // The exact loss shape: two entries, both empty `mock` (what compareShapes
    // emits), critical SECOND. Before the fix the critical was consumed by its
    // predecessor and the collector exited 0 "clean".
    const diffs = [diff(1, EMPTY, "warning"), diff(2, EMPTY, "critical")];
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Chat Completions drift"],
        title: "non-streaming text matches real API",
        failureMessages: [formatDriftReport("OpenAI Chat (non-streaming text)", diffs)],
      }),
    ]);
    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);
    expect(entries[0].diffs.map((d) => d.severity)).toEqual(["warning", "critical"]);
    // The whole point: a printed critical reaches the exit code.
    expect(exitCodeOf(result)).toBe(2);
  });

  it("an empty value is captured as empty, never as the next entry's text", () => {
    const diffs = [diff(1, EMPTY), diff(2, FILLED)];
    const parsed = parseDriftBlock(formatDriftReport("probe", diffs))!;
    expect(parsed.diffs[0].mock).toBe("");
    expect(parsed.diffs[0].mock).not.toContain("issue 2");
  });

  it("every labelled field tolerates an empty value, not just Mock", () => {
    // The sibling separators had the identical hazard; an empty `real`/`expected`
    // would have crossed a newline the same way.
    const diffs: ShapeDiff[] = [
      { path: "p1", severity: "warning", issue: "i1", expected: "", real: "", mock: "" },
      { path: "p2", severity: "critical", issue: "i2", expected: "e", real: "r", mock: "m" },
    ];
    const parsed = parseDriftBlock(formatDriftReport("probe", diffs))!;
    expect(parsed.diffs.map((d) => d.path)).toEqual(["p1", "p2"]);
    expect(parsed.diffs[1].severity).toBe("critical");
  });

  it("NEGATIVE CONTROL: a numbered list in prose is still not an entry", () => {
    // `^` anchoring is what keeps the looser value captures from inventing entries
    // out of ordinary text that happens to contain a numbered line mid-sentence.
    const text =
      "API DRIFT DETECTED: Prose probe\n" +
      "  the provider docs say 1. [critical] do not do this\n" +
      "     Path:    nope\n" +
      "     SDK:     nope\n" +
      "     Real:    nope\n" +
      "     Mock:    nope\n";
    expect(parseDriftBlock(text)!.diffs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Server-initiated CLOSE: refusal vs hang-up vs silence
//
// `fix/ws-preserve-close-code` taught the drift probe to preserve an RFC 6455
// CLOSE frame instead of discarding it, which introduces a failure string no
// parser here had seen:
//
//   WSClosedError: WebSocket closed by server during waitUntil: code=1008
//   reason="Requested model is not supported for BidiGenerateContent.".
//   Collected 0 messages: [] bodies=[]
//
// Measured against this collector before the refusal lane existed, that string
// matched no infra indicator, no handshake recognizer and no timeout recognizer,
// and landed on `exit 5 — manual triage`. That is the same daily hard stop the
// timeout lane was built to remove, re-entering through a new input.
//
// So there are now THREE lanes and they must stay distinguishable, because
// telling them apart is the whole point:
//   - REFUSAL — the frame names something WE sent as unacceptable → attributed
//     critical drift (exit 2), with the code and reason carried into the report.
//   - HANG-UP — the peer left for its own reasons (1011 internal error, 1012
//     restarting, 1000 normal) → nothing graded, exit 6. NOT a finding: calling a
//     provider's own hiccup "drift" pages the team and hands it to the auto-fixer.
//   - SILENCE / GARBAGE — unchanged: exit 6 and exit 5 respectively.
// ---------------------------------------------------------------------------

/** The exact shape `fix/ws-preserve-close-code` emits, per its own source template. */
function wsServerClose(code: number, reason: string, collected = 0): string {
  return (
    `WSClosedError: WebSocket closed by server during waitUntil: code=${code} ` +
    `reason=${JSON.stringify(reason)}. Collected ${collected} messages: [] bodies=[]\n` +
    "    at Timeout._onTimeout (/repo/src/__tests__/drift/ws-providers.ts:319:23)\n" +
    "    at /repo/src/__tests__/drift/ws-gemini-live.drift.ts:88:11"
  );
}

function resultFor(message: string, ancestor = "Gemini Live WS drift"): VitestJsonResult {
  return makeResult([
    makeAssertion({
      status: "failed",
      ancestorTitles: [ancestor],
      title: "WS text event sequence and shapes match",
      failureMessages: [message],
    }),
  ]);
}

describe("a provider that closes the session states its own cause", () => {
  const GEMINI_REASON = "Requested model is not supported for BidiGenerateContent.";

  it("the production refusal (code 1008) becomes attributed critical drift, not triage", () => {
    const result = resultFor(wsServerClose(1008, GEMINI_REASON));
    expect(quarantineOf(result)).toEqual([]);
    expect(timeoutsOf(result)).toEqual([]);
    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);
    expect(entries[0].provider).toBe("Gemini Live");
    expect(entries[0].builderFile).toBe("src/ws-gemini-live.ts");
    expect(entries[0].scenario).toBe("WS session refused");
    expect(exitCodeOf(result)).toBe(2);
  });

  it("the close code AND the stated reason survive into the report", () => {
    // The reason is the entire diagnosis; an entry that dropped it would be
    // actionable in name only.
    const diff = entriesOf(resultFor(wsServerClose(1008, GEMINI_REASON)))[0].diffs[0];
    expect(diff.severity).toBe("critical");
    expect(diff.issue).toContain("1008");
    expect(diff.issue).toContain(GEMINI_REASON);
    expect(diff.real).toContain(GEMINI_REASON);
    expect(diff.id).toBe("ws-close:1008");
  });

  it("the delta key is the close CODE, so rewording the reason does not move it", () => {
    // Providers reword reason prose freely. A key derived from it would re-report
    // the same standing refusal as new-in-head on every PR.
    const a = entriesOf(resultFor(wsServerClose(1008, "Requested model is not supported.")))[0];
    const b = entriesOf(resultFor(wsServerClose(1008, "totally different wording")))[0];
    expect(a.diffs[0].id).toBe(b.diffs[0].id);
  });

  it("a reason containing quotes, backslashes and newlines is decoded, not mangled", () => {
    // The probe emits the reason JSON-quoted, so it is decoded with JSON.parse
    // rather than by hand — provider text is not under our control.
    const nasty = 'model "x\\y" is bad\nsecond line';
    const diff = entriesOf(resultFor(wsServerClose(1008, nasty)))[0].diffs[0];
    expect(diff.real).toContain(nasty);
  });

  it.each([
    [1002, "protocol error"],
    [1003, "unsupported data"],
    [1007, "invalid payload"],
    [1008, "policy violation"],
    [1009, "message too big"],
    [1010, "mandatory extension missing"],
    [4000, "provider-defined"],
    [4999, "provider-defined upper bound"],
  ])("close code %i (%s) is a refusal → exit 2", (code) => {
    expect(isRefusalCloseCode(code as number)).toBe(true);
    expect(exitCodeOf(resultFor(wsServerClose(code as number, "why")))).toBe(2);
  });

  it.each([
    [1000, "normal closure"],
    [1001, "going away"],
    [1004, "reserved, never assigned"],
    [1005, "no status received — never sent on the wire"],
    [1006, "abnormal closure — never sent on the wire"],
    [1011, "server internal error"],
    [1012, "service restarting"],
    [1013, "try again later"],
    [1015, "TLS handshake failure"],
    [3999, "below the application range"],
    [5000, "above the application range"],
  ])("NEGATIVE CONTROL: close code %i (%s) is a hang-up, NOT drift → exit 6", (code) => {
    // Treating a provider's own hiccup as drift pages the team and feeds the
    // auto-fixer a phantom finding. It is surfaced, not swallowed and not blamed.
    expect(isRefusalCloseCode(code as number)).toBe(false);
    const result = resultFor(wsServerClose(code as number, "peer left"));
    expect(entriesOf(result)).toEqual([]);
    expect(quarantineOf(result)).toEqual([]);
    const timeouts = timeoutsOf(result);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].serverClose).toEqual({ code: code as number, reason: "peer left" });
    expect(exitCodeOf(result)).toBe(6);
  });

  it("a hang-up is distinguishable from silence in the record, not just in the exit code", () => {
    // Both are exit 6, so the report is the only place a reader can tell "the peer
    // hung up on us" from "nobody said anything". It has to carry that.
    const hangUp = timeoutsOf(resultFor(wsServerClose(1011, "internal error")))[0];
    expect(hangUp.serverClose).toEqual({ code: 1011, reason: "internal error" });
    expect(hangUp.timeoutMs).toBeUndefined();

    const silence = timeoutsOf(resultFor(CI_ZERO_OBSERVATION_TIMEOUT))[0];
    expect(silence.serverClose).toBeUndefined();
    expect(silence.timeoutMs).toBe(30000);
  });

  it("NEGATIVE CONTROL: silence is STILL exit 6 and garbage is STILL exit 5", () => {
    // The two pre-existing lanes must be untouched by the third.
    expect(exitCodeOf(resultFor(CI_ZERO_OBSERVATION_TIMEOUT))).toBe(6);
    const garbage = resultFor(
      "AssertionError: expected 'gpt-4o-realtime' to be one of\n    at /repo/src/a.ts:1:1",
      "Some unmapped suite",
    );
    expect(quarantineOf(garbage)).toHaveLength(1);
    expect(exitCodeOf(garbage)).toBe(5);
  });

  it("NEGATIVE CONTROL: a refusal from an UNREGISTERED probe quarantines, and says why", () => {
    // An unattributable refusal must not be guessed at — but the quarantine
    // message must name the refusal and the missing registration, not read as
    // "unparseable".
    const msg = wsServerClose(1008, GEMINI_REASON).replace(
      "ws-gemini-live.drift.ts",
      "ws-something-new.drift.ts",
    );
    const result = resultFor(msg, "Some future WS drift");
    expect(entriesOf(result)).toEqual([]);
    const q = quarantineOf(result);
    expect(q).toHaveLength(1);
    expect(q[0].message).toContain("REFUSED");
    expect(q[0].message).toContain("1008");
    expect(q[0].message).toContain("WS_HANDSHAKE_PROBES");
    expect(exitCodeOf(result)).toBe(5);
  });

  // An undecodable reason must never become a confident cause. Three inputs,
  // because they fail at DIFFERENT points and an earlier one masks the later:
  // an unquoted reason never matches the pattern at all, whereas an invalid JSON
  // escape and a raw control character DO match it and then throw in the decoder.
  // Testing only the unquoted form left the decoder's failure path unexercised —
  // a mutation that swallowed the decode error and reported `reason: ""` survived
  // until these two were added.
  it.each([
    ["an unquoted reason (never matches the pattern)", "not-quoted"],
    ["an invalid JSON escape (matches, then throws)", '"bad \\q escape"'],
    ["a raw newline inside the quotes (matches, then throws)", '"line1\nline2"'],
  ])("NEGATIVE CONTROL: %s is not a diagnosis → quarantine", (_label, rawReason) => {
    const broken =
      `WSClosedError: WebSocket closed by server during waitUntil: code=1008 reason=${rawReason}. ` +
      "Collected 0 messages: []\n    at /repo/src/__tests__/drift/ws-gemini-live.drift.ts:88:11";
    expect(parseWSServerClose(broken)).toBeNull();
    // Not drift, not the exit-6 lane — an unreadable cause is unreadable output.
    expect(entriesOf(resultFor(broken))).toEqual([]);
    expect(timeoutsOf(resultFor(broken))).toEqual([]);
    expect(exitCodeOf(resultFor(broken))).toBe(5);
  });

  // The second classification pass re-scans every failed assertion, and it only
  // runs when there is at least one unparseable failure AND no entries. So a
  // recognized close is only at risk of being counted TWICE in a run that ALSO
  // contains garbage — which is exactly the mixed run below. Without the skip in
  // that pass, the hang-up is quarantined on top of being recorded, and the run
  // reports two failures needing triage when only one does.
  it("a hang-up alongside garbage is recorded ONCE, not also quarantined", () => {
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["Some unmapped suite"],
        title: "something broke",
        failureMessages: ["AssertionError: expected 'x' to be one of\n    at /repo/src/a.ts:1:1"],
      }),
      makeAssertion({
        status: "failed",
        ancestorTitles: ["Gemini Live WS drift"],
        title: "WS text event sequence and shapes match",
        failureMessages: [wsServerClose(1011, "internal error")],
      }),
    ]);
    // Exactly the garbage is quarantined; the hang-up stays in its own lane.
    expect(quarantineOf(result)).toHaveLength(1);
    expect(quarantineOf(result)[0].testName).toContain("something broke");
    expect(timeoutsOf(result)).toHaveLength(1);
    expect(exitCodeOf(result)).toBe(5);
  });

  it("an unattributable refusal alongside garbage is quarantined ONCE", () => {
    const unowned = wsServerClose(1008, "nope").replace(
      "ws-gemini-live.drift.ts",
      "ws-something-new.drift.ts",
    );
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["Some unmapped suite"],
        title: "something broke",
        failureMessages: ["AssertionError: expected 'x' to be one of\n    at /repo/src/a.ts:1:1"],
      }),
      makeAssertion({
        status: "failed",
        ancestorTitles: ["Some future WS drift"],
        title: "WS text event sequence and shapes match",
        failureMessages: [unowned],
      }),
    ]);
    expect(quarantineOf(result)).toHaveLength(2);
    expect(quarantineOf(result).filter((q) => q.message.includes("REFUSED"))).toHaveLength(1);
  });

  it("a refusal that also carried messages is still a refusal", () => {
    // The close frame is the terminal fact regardless of what arrived first.
    const result = resultFor(wsServerClose(1008, GEMINI_REASON, 3));
    expect(entriesOf(result)).toHaveLength(1);
    expect(exitCodeOf(result)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Attribution when the stack carries NO probe frame
//
// The refusal above is attributed by the probe's stack frame, and every fixture
// in that block HAS one (`… at …/ws-gemini-live.drift.ts:88:11`). Real CI output
// does not. The client that raises a WS failure is SHARED (`ws-providers.ts`) and
// raises from a socket callback, so the probe's frame does not survive the async
// boundary: run 31571018005 quarantined two Gemini Live legs as "could not be
// mapped to a provider" (exit 5, the manual-triage stop) on a message whose every
// frame is the shared client or a node internal.
//
// That is the hand-authored-fixture trap in its exact form — the fixtures sat in
// the passing class because someone typed a frame the runtime never produces. So
// the fixture below is VERBATIM from that run's own drift-report-base artifact,
// and the first assertion is a STRUCTURAL guard that it contains no probe frame
// at all, so it cannot quietly drift back into the passing class.
// ---------------------------------------------------------------------------

/**
 * VERBATIM failure message from CopilotKit/aimock run 31571018005 (PR #370),
 * lifted from that run's `drift-report-base` artifact quarantine entry. Google
 * refused the session with RFC 6455 code 1007 and said exactly why.
 */
const CI_REFUSED_NO_PROBE_FRAME =
  "WSClosedError: WebSocket closed by server during waitUntil: code=1007 " +
  'reason="The requested combination of response modalities (TEXT) is not supported by the ' +
  'model. models/gemini-3.1-flash-live-preview". Collected 0 messages: [] bodies=[]\n' +
  "    at rejectClosed (/home/runner/work/aimock/base-main/src/__tests__/drift/ws-providers.ts:377:21)\n" +
  "    at check (/home/runner/work/aimock/base-main/src/__tests__/drift/ws-providers.ts:467:21)\n" +
  "    at TLSSocket.<anonymous> (/home/runner/work/aimock/base-main/src/__tests__/drift/ws-providers.ts:525:47)\n" +
  "    at TLSSocket.emit (node:events:509:28)\n" +
  "    at addChunk (node:internal/streams/readable:563:12)\n" +
  "    at readableAddChunkPushByteMode (node:internal/streams/readable:514:3)\n" +
  "    at TLSSocket.Readable.push (node:internal/streams/readable:394:5)\n" +
  "    at TLSWrap.onStreamRead (node:internal/stream_base_commons:189:23)";

/** A server CLOSE reported with the REAL stack: shared client + node internals only. */
function wsServerCloseNoProbeFrame(code: number, reason: string): string {
  return (
    `WSClosedError: WebSocket closed by server during waitUntil: code=${code} ` +
    `reason=${JSON.stringify(reason)}. Collected 0 messages: [] bodies=[]\n` +
    "    at rejectClosed (/repo/src/__tests__/drift/ws-providers.ts:377:21)\n" +
    "    at check (/repo/src/__tests__/drift/ws-providers.ts:467:21)\n" +
    "    at TLSSocket.<anonymous> (/repo/src/__tests__/drift/ws-providers.ts:525:47)\n" +
    "    at TLSSocket.emit (node:events:509:28)"
  );
}

/** A handshake timeout WITH a provider error body, reported without a probe frame. */
function wsErrorTimeoutNoProbeFrame(): string {
  return (
    "Error: waitUntil timeout after 30000ms. Collected 1 messages: [error] " +
    'bodies=[{"type":"error","error":{"type":"invalid_request_error",' +
    '"code":"bad_setup","message":"nope"}}]\n' +
    "    at Timeout._onTimeout (/repo/src/__tests__/drift/ws-providers.ts:412:23)\n" +
    "    at listOnTimeout (node:internal/timers:605:17)"
  );
}

function failureIn(ancestor: string, message: string): VitestJsonResult {
  return makeResult([
    makeAssertion({
      status: "failed",
      ancestorTitles: [ancestor],
      title: "WS text event sequence and shapes match",
      failureMessages: [message],
    }),
  ]);
}

/** The three registered WS probes: live suite title, file, and owning surface. */
const WS_SUITES: readonly [suite: string, probeFile: string, provider: string, builder: string][] =
  [
    ["Gemini Live WS drift", "ws-gemini-live.drift.ts", "Gemini Live", "src/ws-gemini-live.ts"],
    ["OpenAI Realtime API drift", "ws-realtime.drift.ts", "OpenAI Realtime", "src/ws-realtime.ts"],
    [
      "OpenAI Responses WS drift",
      "ws-responses.drift.ts",
      "OpenAI Responses WS",
      "src/ws-responses.ts",
    ],
  ];

describe("a WS failure with no probe frame is attributed by the failing test's name", () => {
  it("the CI fixture really has NO probe frame — the frame key cannot answer", () => {
    // Load-bearing: if this fixture ever grows a `*.drift.ts` frame it stops
    // exercising the production shape and the tests below prove nothing.
    expect(CI_REFUSED_NO_PROBE_FRAME).not.toMatch(/\.drift\.ts/);
    expect(CI_REFUSED_NO_PROBE_FRAME).toContain("ws-providers.ts");
  });

  it("the REAL quarantined CI failure becomes attributed critical drift", () => {
    const result = failureIn("Gemini Live WS drift", CI_REFUSED_NO_PROBE_FRAME);
    expect(quarantineOf(result)).toEqual([]);
    expect(timeoutsOf(result)).toEqual([]);
    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);
    expect(entries[0].provider).toBe("Gemini Live");
    expect(entries[0].builderFile).toBe("src/ws-gemini-live.ts");
    expect(entries[0].builderFunctions).toEqual(["handleWebSocketGeminiLive"]);
    expect(entries[0].scenario).toBe("WS session refused");
    expect(entries[0].diffs[0].severity).toBe("critical");
    expect(entries[0].diffs[0].id).toBe("ws-close:1007");
    // The reason Google gave IS the finding, so it must reach the report.
    expect(entries[0].diffs[0].issue).toContain("response modalities (TEXT) is not supported");
    // 1007 is a refusal code, so the exit is the drift lane. NOT 6: nothing about
    // this failure is silence — the provider stated a cause.
    expect(exitCodeOf(result)).toBe(2);
  });

  it.each(WS_SUITES)(
    "%s attributes a frameless refusal to %s → %s",
    (suite, _file, provider, builder) => {
      // All THREE probes, not just the one that failed in prod: a table that
      // works for one provider is how the hardcoded openai-realtime bug survived.
      const result = failureIn(suite, wsServerCloseNoProbeFrame(1008, "refused"));
      expect(quarantineOf(result)).toEqual([]);
      const entries = entriesOf(result);
      expect(entries).toHaveLength(1);
      expect(entries[0].provider).toBe(provider);
      expect(entries[0].builderFile).toBe(builder);
      expect(exitCodeOf(result)).toBe(2);
    },
  );

  it.each(WS_SUITES)(
    "%s attributes a frameless handshake error to %s → %s",
    (suite, _file, provider, builder) => {
      // The handshake lane keys off the same resolver, and its throw is also
      // raised from the shared client (a setTimeout callback), so it has the same
      // missing-frame problem.
      const result = failureIn(suite, wsErrorTimeoutNoProbeFrame());
      expect(quarantineOf(result)).toEqual([]);
      const entries = entriesOf(result);
      expect(entries).toHaveLength(1);
      expect(entries[0].provider).toBe(provider);
      expect(entries[0].builderFile).toBe(builder);
      expect(entries[0].scenario).toBe("WS handshake");
      expect(exitCodeOf(result)).toBe(2);
    },
  );

  it.each(WS_SUITES)(
    "%s is the REAL describe title of %s, so the label key is not invented here",
    (suite, probeFile, provider) => {
      // The name key is only as good as the titles it matches. Bind the two: the
      // probe's own live-drift describe title must lead with its registry provider
      // label. Renaming that describe fails HERE rather than silently in CI.
      const src = readFileSync(resolve(__dirname, "drift", probeFile), "utf8");
      const titles = [...src.matchAll(/describe(?:\.\w+\([^)]*\))?\(\s*"([^"]+)"/g)].map(
        (m) => m[1],
      );
      const driftTitles = titles.filter((t) => /drift/i.test(t));
      expect(driftTitles).toContain(suite);
      for (const t of driftTitles) expect(t.startsWith(provider)).toBe(true);
    },
  );

  it("NEGATIVE CONTROL: an unregistered suite with no frame STILL quarantines (exit 5)", () => {
    // The whole point of refusing to guess. A confidently wrong owner routes
    // remediation at the wrong file and fails OPEN, which is worse than the stop.
    const result = failureIn("Some future WS drift", wsServerCloseNoProbeFrame(1008, "refused"));
    expect(entriesOf(result)).toEqual([]);
    const q = quarantineOf(result);
    expect(q).toHaveLength(1);
    expect(q[0].provider).toBe("unknown");
    expect(q[0].message).toContain("REFUSED");
    expect(q[0].message).toContain("WS_HANDSHAKE_PROBES");
    // The message must name BOTH keys that failed, so the reader knows a suite
    // title is a fix and not only a stack frame.
    expect(q[0].message).toContain("Some future WS drift");
    expect(exitCodeOf(result)).toBe(5);
  });

  it("NEGATIVE CONTROL: a registered label mid-title does NOT attribute", () => {
    // Anchored at the start, for the same reason extractProviderName is: a label
    // later in a title is a qualifier, not the owner.
    const result = failureIn(
      "Some future WS drift compared against Gemini Live",
      wsServerCloseNoProbeFrame(1008, "refused"),
    );
    expect(entriesOf(result)).toEqual([]);
    expect(quarantineOf(result)).toHaveLength(1);
    expect(exitCodeOf(result)).toBe(5);
  });

  it("NEGATIVE CONTROL: a frameless NON-refusal close is still a hang-up (exit 6)", () => {
    // Attribution must not promote the peer's own hiccup into a finding about us.
    const result = failureIn("Gemini Live WS drift", wsServerCloseNoProbeFrame(1011, "peer left"));
    expect(entriesOf(result)).toEqual([]);
    expect(quarantineOf(result)).toEqual([]);
    expect(timeoutsOf(result)).toHaveLength(1);
    expect(exitCodeOf(result)).toBe(6);
  });

  it("NEGATIVE CONTROL: a registered title does not make garbage parseable", () => {
    // The name key only decides an OWNER; it is not a recognizer. Output that no
    // lane recognizes still quarantines even under a perfectly known suite.
    const result = failureIn(
      "Gemini Live WS drift",
      "AssertionError: expected 'x' to be one of\n    at /repo/src/a.ts:1:1",
    );
    expect(entriesOf(result)).toEqual([]);
    expect(quarantineOf(result)).toHaveLength(1);
    expect(exitCodeOf(result)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Zero-observation live timeouts (exit 6)
//
// The failure that blocked every bot-opened drift PR: the Gemini Live WS legs
// reached their 30s wait having observed nothing, and the collector reported that
// as "unparseable output — manual triage required" (exit 5), which hard-fails the
// base leg of drift-live-pr. A timeout is the single most common failure a live
// harness will ever see; a collector that cannot name it is not classifying.
//
// The message below is VERBATIM from the run that failed (CopilotKit/aimock run
// 31571018005, PR #370) — lifted from that run's own `drift-report-base` artifact,
// not hand-authored to the recognizer.
//
// The negative controls are the load-bearing half. The trap on this fix is
// widening the lane until real output slips through quietly, so: unparseable
// output still quarantines, a timeout that OBSERVED something still quarantines,
// and a drift marker always wins.
// ---------------------------------------------------------------------------

/**
 * A timeout that DID surface a provider `error` body, reported from a given WS
 * drift probe. The frame is the only thing that varies, because the frame is what
 * attribution is supposed to key off.
 */
function wsErrorTimeoutFrom(driftFile: string): string {
  return (
    "Error: waitUntil timeout after 30000ms. Collected 1 messages: [error] " +
    'bodies=[{"type":"error","error":{"type":"invalid_request_error",' +
    '"code":"bad_setup","message":"nope"}}]\n' +
    "    at Timeout._onTimeout (/repo/src/__tests__/drift/ws-providers.ts:319:23)\n" +
    `    at /repo/src/__tests__/drift/${driftFile}:88:11`
  );
}

/** Verbatim CI failure message, run 31571018005 (PR #370), Gemini Live WS legs. */
const CI_ZERO_OBSERVATION_TIMEOUT =
  "Error: waitUntil timeout after 30000ms. Collected 0 messages: [] bodies=[]\n" +
  "    at Timeout._onTimeout (/home/runner/work/aimock/base-main/src/__tests__/drift/ws-providers.ts:319:23)\n" +
  "    at listOnTimeout (node:internal/timers:605:17)\n" +
  "    at processTimers (node:internal/timers:541:7)";

describe("zero-observation live timeouts are reported AS timeouts (exit 6)", () => {
  function ciResult(): VitestJsonResult {
    return makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["Gemini Live WS drift"],
        title: "WS text event sequence and shapes match",
        failureMessages: [CI_ZERO_OBSERVATION_TIMEOUT],
      }),
      makeAssertion({
        status: "failed",
        ancestorTitles: ["Gemini Live WS drift"],
        title: "WS tool call event sequence matches",
        failureMessages: [CI_ZERO_OBSERVATION_TIMEOUT],
      }),
    ]);
  }

  it("routes the REAL CI failure to the timeout lane, not quarantine", () => {
    const result = ciResult();
    expect(quarantineOf(result)).toEqual([]);
    expect(entriesOf(result)).toEqual([]);
    const timeouts = timeoutsOf(result);
    expect(timeouts).toHaveLength(2);
    expect(exitCodeOf(result)).toBe(6);
  });

  it("carries the wait budget, the test name and a jumpable location", () => {
    const [first] = timeoutsOf(ciResult());
    // The budget the probe reported, as a number the reader can act on.
    expect(first.timeoutMs).toBe(30000);
    expect(first.testName).toBe("Gemini Live WS drift > WS text event sequence and shapes match");
    // Captured BEFORE stack stripping, so it points at the probe's own frame.
    expect(first.rawLocation).toBe(
      "/home/runner/work/aimock/base-main/src/__tests__/drift/ws-providers.ts:319:23",
    );
    expect(first.message).toBe(CI_ZERO_OBSERVATION_TIMEOUT);
  });

  it('reports the run as "live-timeout", which is NOT a reusable clean baseline', () => {
    expect(conclusionForExitCode(6)).toBe("live-timeout");
    // The legs that timed out graded nothing, so the run must never be reused as
    // a base that certifies those surfaces drift-free.
    const report: DriftReport = {
      timestamp: "2026-08-12T06:42:00.000Z",
      generatedAt: "2026-08-12T06:42:00.000Z",
      conclusion: conclusionForExitCode(6),
      entries: [
        {
          provider: "OpenAI",
          scenario: "chat",
          builderFile: "src/responses.ts",
          builderFunctions: ["buildChat"],
          typesFile: null,
          sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
          diffs: [SAMPLE_DIFF],
        },
      ],
    };
    expect(isBaseReportReusable(report, "live-timeout", true)).toBe(false);
  });

  // ---- NEGATIVE CONTROLS --------------------------------------------------

  it("NEGATIVE CONTROL: genuinely unparseable output STILL quarantines (exit 5)", () => {
    // Truncated garbage with no drift block, no infra reason, and no timeout tail.
    // If this stops quarantining, the lane has been widened into a silent pass.
    const garbage =
      "AssertionError: expected 'gpt-4o-realtime' to be one of\n" +
      "    at /repo/src/__tests__/drift/ws-realtime.drift.ts:64:11";
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["Some unmapped suite"],
        title: "something broke",
        failureMessages: [garbage],
      }),
    ]);
    expect(timeoutsOf(result)).toEqual([]);
    expect(quarantineOf(result)).toHaveLength(1);
    expect(exitCodeOf(result)).toBe(5);
  });

  it("NEGATIVE CONTROL: a timeout that OBSERVED messages is not a silent surface → still quarantines", () => {
    // Non-zero collected count. The probe saw output; that output is evidence and
    // must not be written off as "the surface sent nothing". (With a provider
    // `error` body it would be handshake drift — asserted separately above.)
    const observedTimeout =
      "Error: waitUntil timeout after 30000ms. Collected 3 messages: [setup, chunk, chunk] " +
      'bodies=[{"type":"setup"}]\n' +
      "    at Timeout._onTimeout (/repo/src/__tests__/drift/ws-providers.ts:319:23)";
    expect(parseLiveTimeout(observedTimeout)).toBeNull();
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["Gemini Live WS drift"],
        title: "WS text event sequence and shapes match",
        failureMessages: [observedTimeout],
      }),
    ]);
    expect(timeoutsOf(result)).toEqual([]);
    expect(quarantineOf(result)).toHaveLength(1);
    expect(exitCodeOf(result)).toBe(5);
  });

  it("NEGATIVE CONTROL: a drift marker beats the timeout tail", () => {
    // A message that carries a drift report is drift, whatever else it says.
    const withMarker =
      "Error: waitUntil timeout after 30000ms. Collected 0 messages: [] bodies=[]\n" +
      "API DRIFT DETECTED: Gemini Live (WS text)\n";
    expect(parseLiveTimeout(withMarker)).toBeNull();
  });

  it("NEGATIVE CONTROL: a bare timeout with no collected-message count still quarantines", () => {
    // No structured count means the probe never stated what it observed, so
    // "observed nothing" is an inference, not a reading.
    const noCount =
      "Error: waitUntil timeout after 30000ms\n" +
      "    at /repo/src/__tests__/drift/ws-providers.ts:319:23";
    expect(parseLiveTimeout(noCount)).toBeNull();
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["Gemini Live WS drift"],
        title: "WS text event sequence and shapes match",
        failureMessages: [noCount],
      }),
    ]);
    expect(quarantineOf(result)).toHaveLength(1);
    expect(exitCodeOf(result)).toBe(5);
  });

  it("real drift on another leg still wins: exit 2, with the timeout recorded alongside", () => {
    // A timed-out leg must not mask, or be masked by, a genuine finding — both
    // are recorded and the actionable one drives the exit code.
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Chat Completions drift"],
        title: "non-streaming text matches real API",
        failureMessages: [formatDriftReport("OpenAI Chat (non-streaming text)", [SAMPLE_DIFF])],
      }),
      makeAssertion({
        status: "failed",
        ancestorTitles: ["Gemini Live WS drift"],
        title: "WS text event sequence and shapes match",
        failureMessages: [CI_ZERO_OBSERVATION_TIMEOUT],
      }),
    ]);
    expect(entriesOf(result)).toHaveLength(1);
    expect(timeoutsOf(result)).toHaveLength(1);
    expect(quarantineOf(result)).toEqual([]);
    expect(exitCodeOf(result)).toBe(2);
  });

  it("a quarantined sibling still wins over a timeout: exit 5", () => {
    // Quarantine outranks live-timeout — a collector fault needs a human even
    // when another leg also went quiet.
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["Some unmapped suite"],
        title: "something broke",
        failureMessages: ["AssertionError: expected 'x' to be one of\n    at /repo/src/a.ts:1:1"],
      }),
      makeAssertion({
        status: "failed",
        ancestorTitles: ["Gemini Live WS drift"],
        title: "WS text event sequence and shapes match",
        failureMessages: [CI_ZERO_OBSERVATION_TIMEOUT],
      }),
    ]);
    expect(quarantineOf(result)).toHaveLength(1);
    expect(timeoutsOf(result)).toHaveLength(1);
    expect(exitCodeOf(result)).toBe(5);
  });

  // The three-way split, pinned. A live WS leg can fail in three ways and they do
  // NOT collapse, because the EVIDENCE differs: an error body is the provider
  // stating why it rejected the session (drift, attributable, auto-fixable);
  // silence is evidence of nothing (timeout); anything else is unreadable
  // (quarantine). Pinned explicitly so the taxonomy is a measured fact rather
  // than something a reader has to reconstruct from three recognizers.
  //
  // Attribution now follows the PROBE, for every registered WS surface. It used to
  // test for a `ws-realtime.drift.ts` frame and hardcode openai-realtime, so a
  // rejected `gemini-live` handshake — the surface that actually goes quiet in
  // production — resolved to nothing and quarantined at exit 5, back into the hard
  // stop this lane exists to avoid. Each row below asserts the surface the failure
  // is routed to, not merely that it was routed somewhere: a lane that attributed
  // every provider to OpenAI Realtime would satisfy a count-only assertion.
  it.each([
    ["ws-realtime.drift.ts", "OpenAI Realtime", "src/ws-realtime.ts"],
    ["ws-gemini-live.drift.ts", "Gemini Live", "src/ws-gemini-live.ts"],
    ["ws-responses.drift.ts", "OpenAI Responses WS", "src/ws-responses.ts"],
  ])(
    "an error-carrying timeout from %s is critical drift owned by %s",
    (frame, wantProvider, wantBuilderFile) => {
      const result = makeResult([
        makeAssertion({
          status: "failed",
          // The ancestor title deliberately says Gemini Live for every row: it must
          // not be what decides the owner, or the frame-based attribution would be
          // untested for the two rows whose title disagrees with their probe.
          ancestorTitles: ["Gemini Live WS drift"],
          title: "WS text event sequence and shapes match",
          failureMessages: [wsErrorTimeoutFrom(frame)],
        }),
      ]);
      expect(quarantineOf(result)).toEqual([]);
      expect(timeoutsOf(result)).toEqual([]);
      const entries = entriesOf(result);
      expect(entries).toHaveLength(1);
      expect(entries[0].provider).toBe(wantProvider);
      expect(entries[0].builderFile).toBe(wantBuilderFile);
      expect(entries[0].diffs[0].severity).toBe("critical");
      expect(entries[0].diffs[0].id).toBe("ws-handshake:bad_setup");
      expect(exitCodeOf(result)).toBe(2);
    },
  );

  it("NEGATIVE CONTROL: an error-carrying timeout from an UNREGISTERED probe still quarantines", () => {
    // An unknown WS surface must not be guessed at. A confident wrong owner routes
    // remediation at the wrong file and fails OPEN, which is worse than the stop.
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["Some future WS drift"],
        title: "WS text event sequence and shapes match",
        failureMessages: [wsErrorTimeoutFrom("ws-something-new.drift.ts")],
      }),
    ]);
    expect(entriesOf(result)).toEqual([]);
    expect(quarantineOf(result)).toHaveLength(1);
    expect(exitCodeOf(result)).toBe(5);
  });

  it("NEGATIVE CONTROL: a registered probe with NO error body is a timeout, not drift", () => {
    // Gate 3 still separates the lanes: silence from a known probe is exit 6, so
    // widening attribution did not let the timeout lane be swallowed by the drift
    // lane.
    const silent =
      "Error: waitUntil timeout after 30000ms. Collected 0 messages: [] bodies=[]\n" +
      "    at Timeout._onTimeout (/repo/src/__tests__/drift/ws-providers.ts:319:23)\n" +
      "    at /repo/src/__tests__/drift/ws-gemini-live.drift.ts:88:11";
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["Gemini Live WS drift"],
        title: "WS text event sequence and shapes match",
        failureMessages: [silent],
      }),
    ]);
    expect(entriesOf(result)).toEqual([]);
    expect(quarantineOf(result)).toEqual([]);
    expect(timeoutsOf(result)).toHaveLength(1);
    expect(exitCodeOf(result)).toBe(6);
  });

  it("a WS handshake failure WITH an error body is still critical drift, not a timeout", () => {
    // parseWSHandshakeFailure runs first and must keep its claim.
    const handshake =
      "Error: waitUntil timeout after 30000ms. Collected 1 messages: [error] " +
      'bodies=[{"type":"error","error":{"type":"invalid_request_error",' +
      '"code":"missing_required_parameter","message":"Missing required parameter."}}]\n' +
      "    at /repo/src/__tests__/drift/ws-realtime.drift.ts:138:26";
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Realtime API drift"],
        title: "WS text event sequence and shapes match (GA)",
        failureMessages: [handshake],
      }),
    ]);
    expect(timeoutsOf(result)).toEqual([]);
    expect(entriesOf(result)).toHaveLength(1);
    expect(exitCodeOf(result)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// parseKnownModelsCanary
// ---------------------------------------------------------------------------

describe("parseKnownModelsCanary", () => {
  it("recovers the FULL unknown-model list from the UNKNOWN_REALTIME_MODELS marker (not truncated)", () => {
    // The printed array is truncated to `…(3)` but the marker carries all four.
    const result = parseKnownModelsCanary(CANARY_MARKER_MULTI);
    expect(result).not.toBeNull();
    expect(result!.ids).toEqual([
      "gpt-realtime-3",
      "gpt-realtime-3-mini",
      "gpt-realtime-3-preview",
      "gpt-realtime-ultra",
    ]);
    // CLASS 3: the marker carries the full list, so nothing is truncated and no
    // prose sentinel may ever occupy an id slot.
    expect(result!.truncated).toBeFalsy();
    expect(result!.ids.every((id) => !id.startsWith("("))).toBe(true);
  });

  it("returns null when the marker is present but the unknown list was empty", () => {
    // Empty unknown list = no drift to surface.
    const msg = "AssertionError: UNKNOWN_REALTIME_MODELS=: expected [] to deeply equal []";
    expect(parseKnownModelsCanary(msg)).toBeNull();
  });

  it("falls through to the printed-array fallback when the marker value is mangled/empty (A2)", () => {
    // A2: an empty/mangled marker must NOT short-circuit to null; it must fall
    // through so a recoverable id in the printed array is still surfaced.
    const msg =
      "AssertionError: UNKNOWN_REALTIME_MODELS=: expected [ 'gpt-realtime-3', …(1) ] to deeply equal []";
    const result = parseKnownModelsCanary(msg);
    expect(result).not.toBeNull();
    expect(result!.ids[0]).toBe("gpt-realtime-3");
    // CLASS 3: truncation is a boolean flag, NOT a prose id in the list.
    expect(result!.truncated).toBe(true);
    expect(result!.ids.every((id) => !id.startsWith("("))).toBe(true);
  });

  it("returns null for a non-canary message", () => {
    expect(parseKnownModelsCanary("TypeError: something unrelated")).toBeNull();
    expect(parseKnownModelsCanary("")).toBeNull();
  });

  describe("fallback (no marker — legacy message shape)", () => {
    // NOTE: the fallback fires ONLY in a confirmed ws-realtime canary context.
    // A REAL marker-less canary failure ALWAYS carries the canary's origin frame
    // (`at …/ws-realtime.drift.ts`), which these fixtures include — that frame
    // is the recognizer that distinguishes a genuine canary from a generic
    // non-canary `toEqual([])` failure in some other provider's test.
    const CANARY_ORIGIN = "\n    at /repo/src/__tests__/drift/ws-realtime.drift.ts:108:69";

    it("detects the single-glyph Unicode ellipsis `…(1)` truncation (as a flag, not a sentinel id)", () => {
      const msg =
        "AssertionError: expected [ 'gpt-realtime-3', …(1) ] to deeply equal []" + CANARY_ORIGIN;
      const result = parseKnownModelsCanary(msg);
      expect(result).not.toBeNull();
      expect(result!.ids[0]).toBe("gpt-realtime-3");
      // CLASS 3: no prose sentinel in the id list; truncation is a boolean.
      expect(result!.truncated).toBe(true);
      expect(result!.ids.every((id) => !id.startsWith("("))).toBe(true);
    });

    it("also detects the three-dot ASCII ellipsis `... (1)` truncation", () => {
      const msg =
        "AssertionError: expected [ 'gpt-realtime-3', ... (1) ] to deeply equal []" + CANARY_ORIGIN;
      const result = parseKnownModelsCanary(msg);
      expect(result!.truncated).toBe(true);
      expect(result!.ids.every((id) => !id.startsWith("("))).toBe(true);
    });

    it("parses a small untruncated printed array", () => {
      const msg =
        "AssertionError: expected [ 'gpt-realtime-3', 'gpt-realtime-3-mini' ] to deeply equal []" +
        CANARY_ORIGIN;
      const result = parseKnownModelsCanary(msg);
      expect(result!.ids).toEqual(["gpt-realtime-3", "gpt-realtime-3-mini"]);
      expect(result!.truncated).toBeFalsy();
    });

    it("returns null for an empty printed array (genuinely no unknown models)", () => {
      const msg = "AssertionError: expected [] to deeply equal []";
      expect(parseKnownModelsCanary(msg)).toBeNull();
    });

    it("flags truncation-only content (glyph present, no extractable id) without inventing a prose id", () => {
      // Inner had a truncation glyph but no quoted ids we could extract. Carries
      // the ws-realtime canary origin path so the fallback gate recognizes it as
      // a genuine canary failure (a real canary failure ALWAYS carries this
      // frame). Without a canary-origin token the fallback must NOT fire.
      const msg =
        "AssertionError: expected [ …(4) ] to deeply equal []\n" +
        "    at /repo/src/__tests__/drift/ws-realtime.drift.ts:108:69";
      const result = parseKnownModelsCanary(msg);
      expect(result).not.toBeNull();
      // CLASS 3: no non-model prose id — the fact lives entirely in `truncated`.
      expect(result!.ids.every((id) => !id.startsWith("("))).toBe(true);
      expect(result!.truncated).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // MISATTRIBUTION GUARD (bucket (a) finding): the printed-array fallback must
  // fire ONLY for a genuine ws-realtime known-models canary failure. A generic
  // `expected [...] to deeply equal []` from ANY OTHER provider/test (no
  // realtime-canary marker AND not originating from ws-realtime.drift.ts) must
  // NOT be claimed as OpenAI-Realtime known-models drift — its arbitrary array
  // contents (which could be a leaked secret, an object shape, anything) must
  // never be relabeled as "unknown model ids".
  // -------------------------------------------------------------------------
  describe("fallback gating — non-canary toEqual([]) is NOT misattributed", () => {
    it("returns null for a non-canary toEqual([]) failure carrying arbitrary array contents (RED before gate)", () => {
      // A DIFFERENT provider's test asserted `toEqual([])` and the array held an
      // arbitrary value — here a leaked-looking secret. NO realtime-canary marker
      // and NO ws-realtime.drift.ts origin: this is not the canary and must not
      // be parsed as one.
      const msg =
        "AssertionError: expected [ 'sk-leaked' ] to deeply equal []\n" +
        "    at /repo/src/__tests__/drift/openai-chat.drift.ts:42:30";
      expect(parseKnownModelsCanary(msg)).toBeNull();
    });

    it("returns null for a bare non-canary toEqual([]) failure with no origin frame at all", () => {
      const msg = "AssertionError: expected [ 'sk-leaked' ] to deeply equal []";
      expect(parseKnownModelsCanary(msg)).toBeNull();
    });

    it("still parses a genuine marker-less canary failure that carries the ws-realtime.drift.ts origin", () => {
      // No structured marker (mangled/stripped), but the stack frame identifies
      // the canary — the fallback SHOULD still recover the id.
      const result = parseKnownModelsCanary(CANARY_FALLBACK_TRUNCATED);
      expect(result).not.toBeNull();
      expect(result!.ids[0]).toBe("gpt-realtime-9");
      expect(result!.truncated).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // CLASS 2 — the NO_GA_REALTIME_MODELS marker (hasGA-false mode)
  // -------------------------------------------------------------------------
  describe("NO_GA_REALTIME_MODELS marker (hasGA-false)", () => {
    it("recognizes the marker and returns the observed model ids with noGA=true", () => {
      const result = parseKnownModelsCanary(CANARY_NO_GA_MARKER);
      expect(result).not.toBeNull();
      expect(result!.noGA).toBe(true);
      expect(result!.ids).toEqual(["gpt-foo", "gpt-bar"]);
    });

    it("recognizes an EMPTY NO_GA marker (no realtime models observed at all) as noGA=true", () => {
      const result = parseKnownModelsCanary(CANARY_NO_GA_EMPTY);
      expect(result).not.toBeNull();
      expect(result!.noGA).toBe(true);
      expect(result!.ids).toEqual([]);
      expect(result!.unknownIds ?? []).toEqual([]);
    });

    it("preserves the unknown-model list carried alongside the NO_GA marker (info-loss fix)", () => {
      // Combined case: no-GA AND new unknown models. The hasGA assertion
      // short-circuits the unknown-models assertion, so the NO_GA marker carries
      // BOTH lists. The observed and unknown lists must be split cleanly.
      const result = parseKnownModelsCanary(CANARY_NO_GA_WITH_UNKNOWN);
      expect(result).not.toBeNull();
      expect(result!.noGA).toBe(true);
      expect(result!.ids).toEqual(["gpt-foo", "gpt-bar"]);
      expect(result!.unknownIds).toEqual(["gpt-realtime-99", "gpt-realtime-99-mini"]);
    });
  });
});

// ---------------------------------------------------------------------------
// classifyUnparseableAsInfra (A3 — symmetric normalization safety net)
// ---------------------------------------------------------------------------

describe("classifyUnparseableAsInfra", () => {
  it("returns false for an EMPTY evidence array — no evidence is NOT proof of infra (CLASS 1)", () => {
    // Vacuous `.every` on [] returns true; the fix must NOT treat "no evidence"
    // as "all clear". Unrecognized ⇒ fail loud, never a false all-clear.
    expect(classifyUnparseableAsInfra([])).toBe(false);
  });

  it("does NOT swallow a failure whose only infra token is confined to a stack frame (A3)", () => {
    // Pre-fix: the raw scan saw ECONNREFUSED in the frame → allInfraErrors true
    // → swallowed. The fix strips frames for BOTH scans, so the token is gone
    // and the failure is not classified as infra.
    expect(classifyUnparseableAsInfra([INFRA_TOKEN_IN_STACKFRAME_ONLY])).toBe(false);
  });

  it("does NOT swallow genuine drift carried in an AssertionError with a leading blank line", () => {
    expect(classifyUnparseableAsInfra([GENUINE_DRIFT_WITH_STACK])).toBe(false);
  });

  it("does NOT treat a bare AssertionError as benign infra", () => {
    const msg = "AssertionError: expected [ 'x' ] to deeply equal []\n    at foo (file:///x)";
    expect(classifyUnparseableAsInfra([msg])).toBe(false);
  });

  it("still classifies genuine infra errors (token in the body) as infra", () => {
    expect(classifyUnparseableAsInfra([REAL_INFRA_BODY])).toBe(true);
    expect(classifyUnparseableAsInfra(["INFRA_ERROR: upstream down\n    at foo (file:///x)"])).toBe(
      true,
    );
    expect(classifyUnparseableAsInfra(["API returned 503 Service Unavailable"])).toBe(true);
  });

  it("does NOT classify a drift body whose VALUE contains 'status 200' as infra (CLASS 1 anchoring)", () => {
    // A real drift value like "status 200" appearing anywhere in the body must
    // not trip the infra gate. The infra 'status \\d{3}' indicator must anchor
    // to the failure reason/line, not a bare substring inside a drift value.
    const msg =
      "AssertionError: \nAPI DRIFT DETECTED: OpenAI Chat (non-streaming text)\n\n" +
      "  1. [critical] LLMOCK DRIFT — mismatch detected\n" +
      "     Path:    choices[0].message.content\n" +
      "     SDK:     status 200\n" +
      "     Real:    status 200\n" +
      "     Mock:    <absent>\n";
    expect(classifyUnparseableAsInfra([msg])).toBe(false);
  });

  it("does NOT classify a labelled 'Real: API returned 503' drift VALUE as infra (CLASS 1 anchoring)", () => {
    // Symmetric to the 'status 200' anchoring case above, and to the already-
    // anchored 'status \\d{3}' sibling. A drift *value* like "API returned 503"
    // appearing AFTER a `Field:` label must NOT trip the infra gate. The
    // 'API returned \\d{3}' indicator must anchor to the failure reason/line
    // (line start, optional `HTTP ` prefix) exactly like 'status \\d{3}' does —
    // an anchoring-defeating `(?:.*:\\s*)?` prefix lets a labelled value match
    // and silently swallow genuine drift. This message is deliberately NOT
    // drift-like (no "drift"/"mismatch"/"expected…to" markers) so the
    // anchoring of the infra indicator is the SOLE determinant of the outcome.
    const msg =
      "     Path:    choices[0].message.content\n" +
      "     SDK:     n/a\n" +
      "     Real: API returned 503\n" +
      "     Mock:    <absent>\n";
    expect(classifyUnparseableAsInfra([msg])).toBe(false);
  });

  it("still classifies a bare line-start 'API returned 503' reason as infra (anchoring preserved)", () => {
    // The anchoring fix must NOT break the genuine infra case: a line whose
    // reason IS "API returned <status>" (optionally `HTTP `-prefixed, at line
    // start) is still infra. Guards against over-tightening the anchor.
    expect(classifyUnparseableAsInfra(["API returned 503 Service Unavailable"])).toBe(true);
    expect(classifyUnparseableAsInfra(["  HTTP API returned 500"])).toBe(true);
  });

  it("does not false-positive drift from a stack-trace filename like ws-realtime.drift.ts", () => {
    // A recognized infra error (token in BODY) whose stack frame mentions
    // "ws-realtime.drift.ts" stays infra — the frame filename is stripped.
    const msg = "fetch failed\n    at handler (file:///repo/src/ws-realtime.drift.ts:5:1)";
    expect(classifyUnparseableAsInfra([msg])).toBe(true);
  });

  // -------------------------------------------------------------------------
  // PROPERTY-BASED uniform-anchoring test — the NON-RECURRING deliverable.
  //
  // Iterates the REAL exported infra-indicator list (INFRA_INDICATOR_SOURCES),
  // NOT a hand-copied subset. For EVERY indicator it asserts through the REAL
  // exported classifyUnparseableAsInfra that:
  //   (a) a labelled drift-body line `Real:    <sample>` (no drift marker) is
  //       NOT classified as infra — genuine drift is surfaced/fail-loud; and
  //   (b) a bare line-start `<sample>` failure reason IS classified as infra.
  //
  // This is what makes the class non-recurring: if a future indicator is added
  // to INFRA_INDICATOR_SPECS but individually mis-anchored (e.g. with the
  // old `(?:.*:\s*)?` prefix or an unanchored `/i`), row (a) fails automatically
  // for that indicator — no one has to remember to add a bespoke test.
  //
  // RED before the uniform-anchoring fix: at minimum the `empty response`,
  // `returned no SSE events`, and `returned empty body` rows fail case (a)
  // (they were `(?:.*:\s*)?`-prefixed or unanchored, so a labelled value matched
  // and swallowed genuine drift). GREEN after: all rows pass both cases.
  // -------------------------------------------------------------------------
  describe("uniform anchoring across the REAL infra-indicator list (property)", () => {
    it("exports a non-empty indicator list to iterate", () => {
      expect(INFRA_INDICATOR_SOURCES.length).toBeGreaterThan(0);
    });

    for (const source of INFRA_INDICATOR_SOURCES) {
      const sample = infraIndicatorSample(source);

      it(`[${source}] a labelled drift-body value "Real: ${sample}" is NOT swallowed as infra (a)`, () => {
        // A labelled body line carrying the phrase as a drift VALUE. No drift
        // marker present, so the infra-indicator anchoring is the SOLE
        // determinant: if the indicator is properly line-anchored it does NOT
        // match here (the phrase follows a `Real:` label), so the batch is not
        // all-infra and the failure is surfaced (classify → false).
        const msg =
          "     Path:    choices[0].message.content\n" +
          "     SDK:     n/a\n" +
          `     Real:    ${sample}\n` +
          "     Mock:    <absent>\n";
        expect(classifyUnparseableAsInfra([msg])).toBe(false);
      });

      it(`[${source}] a bare line-start "${sample}" failure reason IS classified as infra (b)`, () => {
        // The phrase AS the failure reason at line start must still be infra —
        // the anchoring fix must not over-tighten and break genuine infra.
        expect(classifyUnparseableAsInfra([sample])).toBe(true);
      });

      it(`[${source}] taxonomy (c): a bare "${sample}" reason → collector exit 0 (benign, no quarantine)`, () => {
        // A1.4 extension: tie the infra classification to the exit-code taxonomy
        // at the REAL collector surface. A bare infra-reason failure must be a
        // benign exit 0 — NOT quarantined (exit 5) and NOT a crash.
        const result = makeResult([
          makeAssertion({
            status: "failed",
            ancestorTitles: ["OpenAI Chat Completions drift"],
            title: "non-streaming text matches real API",
            failureMessages: [sample],
          }),
        ]);
        expect(() => collectDriftEntries(result)).not.toThrow();
        expect(entriesOf(result)).toEqual([]);
        expect(quarantineOf(result)).toEqual([]);
        expect(exitCodeOf(result)).toBe(0);
      });

      it(`[${source}] taxonomy (c'): a labelled "Real: ${sample}" drift value → NOT exit 0 (quarantined, exit 5)`, () => {
        // Symmetric to (a) at the collector surface: a labelled body value that
        // merely CONTAINS the infra phrase must never be swallowed as a green.
        // It is not a full parseable drift block, so it is quarantined (exit 5).
        const msg =
          "     Path:    choices[0].message.content\n" +
          "     SDK:     n/a\n" +
          `     Real:    ${sample}\n` +
          "     Mock:    <absent>\n";
        const result = makeResult([
          makeAssertion({
            status: "failed",
            ancestorTitles: ["OpenAI Chat Completions drift"],
            title: "non-streaming text matches real API",
            failureMessages: [msg],
          }),
        ]);
        expect(exitCodeOf(result)).not.toBe(0);
        expect(exitCodeOf(result)).toBe(5);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// D6.2 — per-item `id` field on ParsedDiff
//
// The delta layer (D6.1) keys findings by `provider+id`. For N distinct unknown
// model ids, the collector must produce N DISTINCT per-item `id` values so that
// a downstream `provider+id` keying yields N distinct keys — not 1 collapsed
// key under the shared `path` bucket (pre-fix behaviour when `id` was
// absent/undefined).
//
// RED (pre-fix): `id` is unset on every ParsedDiff produced by the canary path,
//   so all 3 diffs have `id === undefined` → only 1 distinct key.
// GREEN (post-fix): each diff carries `id` = the model id stored in `diff.real`,
//   so 3 distinct unknown ids → 3 distinct `id` values → 3 distinct keys.
// ---------------------------------------------------------------------------

describe("D6.2 — per-item id on ParsedDiff", () => {
  // Three distinct hypothetical unknown model ids (not in knownVoiceModelFamilies
  // in src/__tests__/drift/voice-models.ts — A4 note: hypothetical ids only).
  const THREE_UNKNOWN_IDS_CANARY =
    "AssertionError: UNKNOWN_REALTIME_MODELS=gpt-realtime-x1,gpt-realtime-x2,gpt-realtime-x3: " +
    "expected [ 'gpt-realtime-x1', …(2) ] to deeply equal []\n" +
    "    at /repo/src/__tests__/drift/ws-realtime.drift.ts:108:69";

  it("D6.2 RED→GREEN: 3 distinct canary model ids produce 3 DISTINCT per-item id fields (not collapsed under undefined)", () => {
    const result = makeResult([
      makeAssertion({
        status: "failed",
        ancestorTitles: ["OpenAI Realtime API drift"],
        title: "canary: GA realtime models available",
        failureMessages: [THREE_UNKNOWN_IDS_CANARY],
      }),
    ]);

    const entries = entriesOf(result);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.provider).toBe("OpenAI Realtime");

    // There should be exactly 3 diffs — one per unknown model id.
    expect(entry.diffs).toHaveLength(3);

    // D6.2 core assertion: each diff must carry a populated `id` field equal to
    // the model id in `diff.real`, and all three must be distinct.
    const ids = entry.diffs.map((d) => d.id);
    expect(ids).toEqual(["gpt-realtime-x1", "gpt-realtime-x2", "gpt-realtime-x3"]);

    // All three ids are defined (not undefined).
    expect(ids.every((id) => id !== undefined)).toBe(true);

    // All three ids are DISTINCT — a downstream provider+id key would yield 3
    // different keys, not 1 collapsed key under undefined/absent id.
    const distinctIds = new Set(ids);
    expect(distinctIds.size).toBe(3);

    // The model ids must match what's in `diff.real` (the source of truth).
    for (const diff of entry.diffs) {
      expect(diff.id).toBe(diff.real);
    }
  });

  it("D6.2: parseDriftBlock-path diffs carry a stable id derived from path", () => {
    // For regular drift-block diffs (not canary), `id` is derived from
    // the `path` field so different paths → different ids.
    const formatted = formatDriftReport("OpenAI Chat (non-streaming text)", [
      { ...SAMPLE_DIFF, path: "choices[0].message.refusal" },
      { ...SAMPLE_DIFF, path: "choices[0].message.content", severity: "warning" as const },
    ]);
    const parsed = parseDriftBlock(formatted);
    expect(parsed).not.toBeNull();
    expect(parsed!.diffs).toHaveLength(2);

    const ids = parsed!.diffs.map((d) => d.id);
    // Both diffs must have a non-empty id.
    expect(ids.every((id) => id !== undefined && id !== "")).toBe(true);
    // The two paths are different → two distinct ids.
    expect(new Set(ids).size).toBe(2);
    // Each id must be derived from (or equal to) the path.
    for (const diff of parsed!.diffs) {
      expect(diff.id).toBe(diff.path);
    }
  });
});

// ---------------------------------------------------------------------------
// The delta key must not be coupled to a DISPLAY string.
//
// drift-delta keys a failure by `provider + (diff.id ?? diff.path)`. Two canary
// diffs shipped with NO `id` — the no-GA diff and the truncation diff — so their
// delta key WAS their `path`, which is also the human-facing "Path:" line of the
// alert. That coupling means renaming the prose (as 6614bb2 did, `gaModels` →
// `gaRealtimeModels`) silently MOVES the key: a drift already recorded in the
// cached same-UTC-day BASE report is re-classified as new-in-head and BLOCKS the
// PR, while the base key is reported as spuriously "fixed".
//
// The fix is not to freeze the display string — a `path` naming a symbol that no
// longer exists is the exact bug this file's sibling guard exists to kill. It is
// to give those two diffs an explicit, stable, SEMANTIC id so the display string
// is free to change and the key never moves again.
// ---------------------------------------------------------------------------

describe("canary delta keys are decoupled from the human-facing path string", () => {
  function reportOf(diffs: ParsedDiff[], timestamp = "2026-08-03T00:00:00.000Z"): DriftReport {
    return {
      timestamp,
      entries: [
        {
          provider: "OpenAI Realtime",
          scenario: "known-models canary",
          builderFile: "b.ts",
          builderFunctions: ["f"],
          typesFile: null,
          sdkShapesFile: "shapes.ts",
          diffs,
        },
      ],
    };
  }

  function canaryDiffs(message: string): ParsedDiff[] {
    const entries = entriesOf(
      makeResult([
        makeAssertion({
          status: "failed",
          ancestorTitles: ["OpenAI Realtime API drift"],
          title: "canary: GA realtime models available",
          failureMessages: [message],
        }),
      ]),
    );
    expect(entries).toHaveLength(1);
    return entries[0].diffs;
  }

  // Characterization of the MECHANISM, so the coupling can never be re-created
  // silently: with no `id`, a path-only rename moves the key. (Watched to fail by
  // stubbing indexReport's `diff.id ?? diff.path` to a constant.)
  it("MECHANISM: with no per-item id, renaming `path` alone moves the delta key", () => {
    const idLess = (path: string): ParsedDiff => ({
      path,
      severity: "critical",
      issue: "GA realtime family unavailable",
      expected: "(at least one GA realtime model present)",
      real: "no realtime models observed",
      mock: "<no mock leg>",
    });
    const { block, advisory, fixed } = computeDelta(
      reportOf([idLess("gaModels")]),
      reportOf([idLess("gaRealtimeModels")]),
    );
    expect(advisory).toEqual([]);
    expect(block.map((k) => k.id)).toEqual(["gaRealtimeModels"]);
    expect(fixed.map((k) => k.id)).toEqual(["gaModels"]);
  });

  it("a stable per-item id makes the SAME path rename key-neutral (stays advisory)", () => {
    const keyed = (path: string): ParsedDiff => ({
      path,
      id: NO_GA_DELTA_ID,
      severity: "critical",
      issue: "GA realtime family unavailable",
      expected: "(at least one GA realtime model present)",
      real: "no realtime models observed",
      mock: "<no mock leg>",
    });
    const { block, advisory, fixed } = computeDelta(
      reportOf([keyed("gaModels")]),
      reportOf([keyed("gaRealtimeModels")]),
    );
    expect(block).toEqual([]);
    expect(fixed).toEqual([]);
    expect(advisory.map((k) => k.id)).toEqual([NO_GA_DELTA_ID]);
  });

  it("the collector sets the stable id on the no-GA diff", () => {
    const diffs = canaryDiffs(CANARY_NO_GA_MARKER);
    const noGA = diffs.filter((d) => d.path === "gaRealtimeModels");
    expect(noGA).toHaveLength(1);
    expect(noGA[0].id).toBe(NO_GA_DELTA_ID);
  });

  it("the collector sets the stable id on the truncation diff", () => {
    const diffs = canaryDiffs(CANARY_FALLBACK_TRUNCATED);
    const truncation = diffs.filter((d) => d.path === "knownVoiceModelFamilies[truncated]");
    expect(truncation).toHaveLength(1);
    expect(truncation[0].id).toBe(TRUNCATED_DELTA_ID);
  });

  // Vacuity guard: EVERY canary diff the collector can emit must now carry an
  // `id`, so no future canary diff can silently re-acquire a path-derived key.
  it("no canary diff is left keyed by its display path", () => {
    for (const message of [
      CANARY_NO_GA_MARKER,
      CANARY_NO_GA_WITH_UNKNOWN,
      CANARY_NO_GA_EMPTY,
      CANARY_MARKER_MULTI,
      CANARY_FALLBACK_TRUNCATED,
    ]) {
      for (const d of canaryDiffs(message)) {
        expect(
          d.id,
          `canary diff path=${d.path} has no stable id — it would key on its ` +
            `display path, so renaming the alert prose would move its delta key`,
        ).toBeTruthy();
      }
    }
  });
});

// ===========================================================================
// Delta-key PROVENANCE — the gate's annotation cannot print a symbol that
// does not exist
// ===========================================================================

/**
 * The delta gate annotates a blocking key as `${k.provider} ${k.id}` (the
 * "Delta gate" step of .github/workflows/test-drift.yml), so `DeltaKey.id` is the
 * entire identifier a human gets when the required check hard-fails. `indexReport`
 * builds it as `diff.id ?? diff.path` — so a diff with no `id` promotes a
 * HUMAN-FACING DISPLAY STRING to the key. That is how `gaModels` and
 * `knownModels[truncated]`, symbols retired from this repo, became printable delta
 * keys: the annotation named a symbol the reader could not find anywhere.
 *
 * `98b9cf1` gave those two diffs explicit semantic ids, which fixes the current
 * tree; this makes the property STRUCTURAL. Every key a collector-CONSTRUCTED diff
 * can contribute must have one of three provenances, none of which can be an
 * arbitrary display string:
 *
 *   semantic — `<namespace>:<slug>` with the namespace in the explicit
 *              SEMANTIC_DELTA_ID_NAMESPACES allowlist. Namespaced, so it reads as
 *              a key and is never mistaken for a symbol to go look up.
 *   observed — the id IS the value the live API returned (it equals the diff's
 *              `real`), i.e. wire data rather than repo prose.
 *   declared — the id is a symbol EXPORTED by a drift classification module
 *              (`src/__tests__/drift/*.ts`), so a reader who greps it lands on the
 *              actual seed set / rule the annotation is pointing at. Deliberately
 *              NOT "declared anywhere in the repo" — see
 *              `driftModuleExportsIdentifier`.
 *
 * Anything else fails: a bare display string, a prose bucket, a retired symbol
 * name, or a missing `id` whose `path` falls through to the key.
 *
 * SCOPE: the diffs the collector writes ITSELF — the realtime-canary and WS
 * handshake lanes — whose `path`/`id` are hand-authored. A diff parsed out of a
 * formatted drift block carries the probe's observed wire path
 * (`choices[0].message.refusal`), which is data from the run rather than a symbol
 * citation, and is out of scope.
 *
 * Composes with drift-remediation-strings.test.ts, which separately forbids any
 * RETIRED symbol name anywhere in the collector source: a `declared` id cannot be
 * a retired symbol here, and a `semantic` id cannot smuggle one into its slug
 * there.
 */
const SEMANTIC_DELTA_ID_NAMESPACES: readonly string[] = [
  // The two id-less realtime-canary diffs: NO_GA_DELTA_ID / TRUNCATED_DELTA_ID.
  "openai-realtime",
  // The WS handshake lane: `ws-handshake:<provider error code>`.
  "ws-handshake",
];

/**
 * The WS handshake lane's fixture. Shaped to parseWSHandshakeFailure's three
 * documented gates — a `waitUntil timeout`, the ws-realtime.drift.ts stack frame,
 * and a surfaced provider `error` body. Unlike the canary fixtures above, this one
 * is hand-authored to those gates rather than captured.
 */
const WS_HANDSHAKE_ERROR_FAILURE =
  "AssertionError: waitUntil timeout after 10000ms; last message: " +
  '{"type":"error","error":{"type":"invalid_request_error","code":"invalid_api_key",' +
  '"message":"Incorrect API key provided."}}\n' +
  "    at /repo/src/__tests__/drift/ws-realtime.drift.ts:64:11";

/** The namespace of a `<namespace>:<slug>` id, or null when it is not namespaced. */
function deltaIdNamespace(id: string): string | null {
  const colon = id.indexOf(":");
  if (colon <= 0 || colon >= id.length - 1) return null;
  return id.slice(0, colon);
}

/**
 * The drift CLASSIFICATION package — `src/__tests__/drift/*.ts`: the voice/model
 * seed sets, the registry, the normalizers, the surface registry. These are the
 * modules a human sent a delta key would actually open, because they hold the data
 * the key names and the rule that has to change.
 *
 * SCOPED DELIBERATELY. An earlier revision of this guard scanned every `.ts` under
 * `src/` and `scripts/` for ANY `const|function|class|…` declaration of the name,
 * which made the `declared` provenance a near-wildcard: `path`, `models`,
 * `entries`, `key`, `id`, `usage`, `body`, `type` — 20 of 20 generic one-word
 * strings tried — are each some local `const` somewhere in the tree, so a bare
 * display path satisfied it and the guard stopped binding on the thing it exists
 * to prevent. Read once; the per-key check runs over the cached text.
 */
let driftModuleSourcesCache: string[] | null = null;
function driftModuleSources(): string[] {
  if (driftModuleSourcesCache !== null) return driftModuleSourcesCache;
  const dir = resolve(__dirname, "drift");
  driftModuleSourcesCache = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => readFileSync(resolve(dir, e.name), "utf8"));
  return driftModuleSourcesCache;
}

/**
 * Does a drift classification module EXPORT `id` under exactly that name?
 *
 * Two structural requirements, both load-bearing:
 *   - EXPORTED (`^export`, `m`-anchored so it is a top-level export and not an
 *     indented interior binding) — an unexported local is not something a reader
 *     can look up, and it is what let bare display words through.
 *   - declared IN the drift package — a symbol from an unrelated corner of the
 *     repo is not the data set the annotation is pointing at.
 *
 * `\b` after the name keeps the match exact (`gaModels` must not be satisfied by
 * `gaModelsRetired`).
 */
function driftModuleExportsIdentifier(id: string): boolean {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(id)) return false;
  const decl = new RegExp(
    `^export\\s+(?:declare\\s+)?(?:const|let|var|function|class|interface|type|enum)\\s+${id}\\b`,
    "m",
  );
  return driftModuleSources().some((src) => decl.test(src));
}

type DeltaKeyProvenance = "semantic" | "observed" | "declared";

/**
 * Classify the provenance of the delta key a diff will contribute, keying it
 * EXACTLY as `indexReport` does (`diff.id ?? diff.path`). null = no provenance:
 * the key is an arbitrary display string and the gate could annotate it at a
 * human as if it were something to look up.
 */
function deltaKeyProvenanceOf(diff: ParsedDiff): DeltaKeyProvenance | null {
  const key = diff.id ?? diff.path;
  const namespace = deltaIdNamespace(key);
  if (namespace !== null && SEMANTIC_DELTA_ID_NAMESPACES.includes(namespace)) return "semantic";
  if (key.length > 0 && key === diff.real) return "observed";
  if (driftModuleExportsIdentifier(key)) return "declared";
  return null;
}

/** Every diff the collector CONSTRUCTS itself, labelled by the lane it came from. */
function constructedDiffs(): { lane: string; diff: ParsedDiff }[] {
  const lanes: Record<string, string> = {
    "canary no-GA (marker)": CANARY_NO_GA_MARKER,
    "canary no-GA + unknown": CANARY_NO_GA_WITH_UNKNOWN,
    "canary no-GA (empty list)": CANARY_NO_GA_EMPTY,
    "canary unknown models": CANARY_MARKER_MULTI,
    "canary truncated": CANARY_FALLBACK_TRUNCATED,
    "WS handshake error": WS_HANDSHAKE_ERROR_FAILURE,
  };
  const out: { lane: string; diff: ParsedDiff }[] = [];
  for (const [lane, message] of Object.entries(lanes)) {
    const entries = entriesOf(
      makeResult([
        makeAssertion({
          status: "failed",
          ancestorTitles: ["OpenAI Realtime API drift"],
          title: "canary: GA realtime models available",
          failureMessages: [message],
        }),
      ]),
    );
    for (const entry of entries) {
      for (const diff of entry.diffs) out.push({ lane, diff });
    }
  }
  return out;
}

describe("every delta key the collector constructs has a provenance", () => {
  const constructed = constructedDiffs();

  const idLess = (path: string): ParsedDiff => ({
    path,
    severity: "critical",
    issue: "GA realtime family unavailable",
    expected: "(at least one GA realtime model present)",
    real: "no realtime models observed",
    mock: "<no mock leg>",
  });

  // Vacuity guard: the per-key cases below are GENERATED from the enumeration, so
  // an enumeration that quietly found nothing would report a green suite with no
  // cases in it. Both id-less canary diffs, the per-model diffs and the WS lane
  // must be present.
  it("enumerates the collector's constructed diffs", () => {
    expect(constructed.length, "constructed diffs found").toBeGreaterThanOrEqual(8);
    expect(new Set(constructed.map((c) => c.lane)).size, "lanes covered").toBe(6);
    const keys = constructed.map((c) => c.diff.id ?? c.diff.path);
    expect(keys).toContain(NO_GA_DELTA_ID);
    expect(keys).toContain(TRUNCATED_DELTA_ID);
    expect(keys).toContain("ws-handshake:invalid_api_key");
  });

  // Known-positive controls: the classifier must ACCEPT each provenance, not just
  // reject bad input. Without these a classifier that returned "semantic" for
  // everything, or a repo scan that matched everything, would look green.
  it("accepts each of the three provenances", () => {
    expect(deltaKeyProvenanceOf(idLess("x")), "unclassifiable control").toBeNull();
    expect(deltaKeyProvenanceOf({ ...idLess("gaRealtimeModels"), id: NO_GA_DELTA_ID })).toBe(
      "semantic",
    );
    expect(
      deltaKeyProvenanceOf({
        ...idLess("knownVoiceModelFamilies"),
        id: "gpt-realtime-99",
        real: "gpt-realtime-99",
      }),
    ).toBe("observed");
    // `gaRealtimeModels` really is declared in src/__tests__/drift/voice-models.ts.
    expect(deltaKeyProvenanceOf(idLess("gaRealtimeModels"))).toBe("declared");
  });

  // Known-negative controls: the two keys that actually shipped, and the shape of
  // the regression this guard exists to catch.
  it("rejects a retired symbol name and a prose bucket", () => {
    expect(deltaKeyProvenanceOf(idLess("gaModels")), "retired symbol as path").toBeNull();
    expect(
      deltaKeyProvenanceOf(idLess("knownModels[truncated]")),
      "retired symbol + bucket suffix as path",
    ).toBeNull();
    expect(
      deltaKeyProvenanceOf({ ...idLess("gaRealtimeModels"), id: "gaModels" }),
      "retired symbol as an explicit id",
    ).toBeNull();
    expect(
      deltaKeyProvenanceOf({
        ...idLess("knownVoiceModelFamilies[truncated]"),
        id: "knownVoiceModelFamilies[truncated]",
      }),
      "display path copied into the id",
    ).toBeNull();
  });

  // The `declared` provenance is the loosest of the three, so it is the one that
  // can quietly stop binding. It must mean "names a symbol the drift
  // classification modules EXPORT" — a reader greps it and lands on the data set
  // to edit. It must NOT mean "this string appears as any identifier anywhere in
  // src/ or scripts/": every one of these bare words is some local `const`
  // somewhere in the repo, so under that reading a one-word display path would
  // satisfy the guard and the gate could print `<provider> path` at a human.
  it("rejects a bare generic one-word display path (`declared` is not a near-wildcard)", () => {
    for (const word of [
      "path",
      "models",
      "entries",
      "key",
      "id",
      "report",
      "usage",
      "choices",
      "message",
      "content",
      "delta",
      "error",
      "data",
      "result",
      "response",
      "request",
      "body",
      "status",
      "type",
      "value",
    ]) {
      expect(
        deltaKeyProvenanceOf(idLess(word)),
        `"${word}" is a bare display path, not a symbol a reader can look up`,
      ).toBeNull();
    }
  });

  for (const { lane, diff } of constructed) {
    it(`${lane}: "${diff.id ?? diff.path}" has a provenance`, () => {
      expect(
        deltaKeyProvenanceOf(diff),
        `The delta key for this ${lane} diff is "${diff.id ?? diff.path}", which is ` +
          `neither a namespaced semantic id (${SEMANTIC_DELTA_ID_NAMESPACES.join(", ")}), ` +
          `nor the value the API returned, nor an identifier this repo declares. The ` +
          `drift gate prints that key verbatim at a human — as "<provider> ` +
          `${diff.id ?? diff.path}" — when it hard-fails the required check, so it must ` +
          `not be an arbitrary display string. Give the diff an explicit semantic id ` +
          `(see NO_GA_DELTA_ID) instead of letting its display path become the key.`,
      ).not.toBeNull();
    });
  }
});

// ===========================================================================
// WS-5 — structural surface keying via SURFACE_REGISTRY
// ===========================================================================

describe("WS-5 extractSurfaceKey", () => {
  it("reads the Surface: marker line emitted by formatDriftReport(surface)", () => {
    const block = formatDriftReport(
      "Cohere /v2/chat (non-streaming)",
      [SAMPLE_DIFF],
      "cohere-chat",
    );
    expect(extractSurfaceKey(block)).toBe("cohere-chat");
  });

  it("returns null for a legacy block with no Surface: marker", () => {
    const block = formatDriftReport("Cohere /v2/chat (non-streaming)", [SAMPLE_DIFF]);
    expect(extractSurfaceKey(block)).toBeNull();
  });
});

describe("WS-5 — previously-quarantined surfaces now route to exit-2 entries", () => {
  // A drift block for a surface that today is NOT a PROVIDER_MAP key. On old
  // code these route to a quarantine (exit 5) because extractProviderName
  // returns null. With the surface marker + registry they become auto-fixable
  // exit-2 entries.
  //
  // CRITICAL — each title below is NEUTRAL PROSE that contains NO registry
  // provider label (nor a legacy alias) as a substring, in either the ancestor
  // title OR the emitted context. That is deliberate: it means the legacy
  // `extractProviderName` fallback returns null for every one of these, so the
  // ONLY thing that can route them to an entry is the `Surface:` marker seam. If
  // the WS-5 seam is reverted, ALL of these go RED (verified). This closes the
  // F1 gap where fal/elevenlabs stayed green on revert because their titles
  // happened to contain the legacy label substring. (≥3 cells; 4 for margin.)
  const CASES: { surface: string; title: string; provider: string; builderFile: string }[] = [
    {
      surface: "moderation",
      title: "content-safety endpoint 400 payload",
      provider: "OpenAI Moderations",
      builderFile: "src/moderation.ts",
    },
    {
      surface: "video",
      title: "async media generation status poll",
      provider: "OpenAI Video",
      builderFile: "src/video.ts",
    },
    {
      surface: "transcription",
      title: "audio-to-text multipart upload",
      provider: "Transcription",
      builderFile: "src/transcription.ts",
    },
    {
      surface: "rerank",
      title: "document relevance scoring endpoint",
      provider: "Cohere Rerank",
      builderFile: "src/rerank.ts",
    },
  ];

  for (const c of CASES) {
    it(`RED→GREEN: "${c.surface}" drift → exit-2 entry (marker-only, legacy label CANNOT rescue)`, () => {
      const block = formatDriftReport(c.title, [SAMPLE_DIFF], c.surface);
      const result = makeResult([
        makeAssertion({
          ancestorTitles: [`${c.title} drift`],
          title: "shape matches SDK",
          failureMessages: [`AssertionError: ${block}`],
        }),
      ]);

      // Guard the guard: the neutral prose title must NOT be resolvable via the
      // legacy provider-label path, so the marker seam is genuinely required. If
      // this ever starts returning non-null, the RED→GREEN below is a false lock.
      expect(extractProviderName(`${c.title} drift`)).toBeNull();
      expect(extractProviderName(c.title)).toBeNull();

      const { entries, quarantine } = collectDriftEntries(result);
      // The fix: routed to a trustworthy entry, NOT quarantined.
      expect(quarantine).toHaveLength(0);
      expect(entries).toHaveLength(1);

      const entry = entries[0];
      expect(entry.provider).toBe(c.provider);
      expect(entry.builderFile).toBe(c.builderFile);
      expect(entry.builderFunctions.length).toBeGreaterThan(0);
      expect(entry.sdkShapesFile.length).toBeGreaterThan(0);

      // Exit code: 2 (auto-fixable), not 5 (quarantine).
      expect(exitCodeOf(result)).toBe(2);
    });
  }

  it("legacy no-marker fallback: a truly un-keyable block still quarantines (exit 5)", () => {
    // A marker-less block whose prose title matches NO registry provider label
    // routes to quarantine exactly as before WS-5 — the defensive legacy net is
    // preserved for genuinely un-attributable output.
    const block = formatDriftReport("SomeBrandNewProvider /v9/widgets", [SAMPLE_DIFF]);
    const result = makeResult([
      makeAssertion({
        ancestorTitles: ["SomeBrandNewProvider drift"],
        title: "shape matches SDK",
        failureMessages: [`AssertionError: ${block}`],
      }),
    ]);
    const { entries, quarantine } = collectDriftEntries(result);
    expect(entries).toHaveLength(0);
    expect(quarantine).toHaveLength(1);
    expect(exitCodeOf(result)).toBe(5);
  });

  it("legacy no-marker fallback still resolves a known provider LABEL to an entry", () => {
    // Back-compat: an unmigrated block that carries no Surface: marker but whose
    // prose title contains a registered provider label still routes to an entry.
    const block = formatDriftReport("Cohere Chat completions", [SAMPLE_DIFF]);
    const result = makeResult([
      makeAssertion({
        ancestorTitles: ["Cohere Chat drift"],
        title: "shape matches SDK",
        failureMessages: [`AssertionError: ${block}`],
      }),
    ]);
    const { entries, quarantine } = collectDriftEntries(result);
    expect(quarantine).toHaveLength(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].builderFile).toBe("src/cohere.ts");
  });
});

describe("WS-5 — unknown surface slug fails LOUD (throws), never silent quarantine", () => {
  it("collectDriftEntries throws on a marker with a slug not in the registry", () => {
    // Build the block manually — formatDriftReport(surface) would itself throw
    // on an unknown slug, so synthesize the marker directly to exercise the
    // COLLECTOR's runtime throw.
    const block =
      "\nAPI DRIFT DETECTED: Totally New Surface\n" +
      "  Surface: totally-new-surface\n\n" +
      "  1. [critical] LLMOCK DRIFT — mismatch detected\n" +
      "     Path:    a.b.c\n" +
      "     SDK:     null\n" +
      "     Real:    null\n" +
      "     Mock:    <absent>\n";
    const result = makeResult([
      makeAssertion({
        ancestorTitles: ["Totally New Surface drift"],
        title: "shape matches SDK",
        failureMessages: [`AssertionError: ${block}`],
      }),
    ]);

    expect(() => collectDriftEntries(result)).toThrow(
      /Unknown drift surface "totally-new-surface"/,
    );
  });

  it("formatDriftReport throws at emit time on an unknown slug", () => {
    expect(() => formatDriftReport("X", [SAMPLE_DIFF], "not-a-real-surface")).toThrow(
      /unknown drift surface "not-a-real-surface"/,
    );
  });

  it.each(["constructor", "__proto__", "hasOwnProperty", "toString", "valueOf"])(
    "throws (not garbage entry) when the marker slug is the Object.prototype member %s",
    (protoSlug) => {
      // A prototype-chain bracket lookup (SURFACE_REGISTRY[slug]) would resolve
      // these to a truthy INHERITED member and skip the throw, emitting a
      // DriftEntry with builderFile: undefined. The Object.hasOwn / isKnownSurface
      // guard must treat them as unknown and THROW loudly.
      const block =
        `\nAPI DRIFT DETECTED: Prototype Slug\n` +
        `  Surface: ${protoSlug}\n\n` +
        "  1. [critical] LLMOCK DRIFT — mismatch detected\n" +
        "     Path:    a.b.c\n" +
        "     SDK:     null\n" +
        "     Real:    null\n" +
        "     Mock:    <absent>\n";
      const result = makeResult([
        makeAssertion({
          ancestorTitles: ["Prototype Slug drift"],
          title: "shape matches SDK",
          failureMessages: [`AssertionError: ${block}`],
        }),
      ]);

      expect(() => collectDriftEntries(result)).toThrow(
        new RegExp(`Unknown drift surface "${protoSlug.replace(/[$]/g, "\\$&")}"`),
      );
    },
  );
});

describe("WS-5 — base-report reuse contract (generatedAt + conclusion)", () => {
  /**
   * A DriftEntry shaped as main() really writes them: entries exist only for
   * FAILED assertions, and always carry at least one diff (a block that parses to
   * zero diffs is routed to the unparseable/quarantine lane instead). Fixtures
   * below use this rather than an entry with `diffs: []`, which main() never emits.
   */
  const driftingEntry = (): DriftReport["entries"][number] => ({
    provider: "OpenAI Chat",
    scenario: "non-streaming text",
    builderFile: "src/helpers.ts",
    builderFunctions: ["buildTextCompletion"],
    typesFile: "src/types.ts",
    sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
    diffs: [
      {
        path: "usage.prompt_tokens",
        severity: "critical",
        issue: "type mismatch",
        expected: "number",
        real: "string",
        mock: "number",
      },
    ],
  });

  it("conclusionForExitCode maps exit codes to coarse conclusions", () => {
    expect(conclusionForExitCode(0)).toBe("clean");
    expect(conclusionForExitCode(2)).toBe("critical");
    expect(conclusionForExitCode(5)).toBe("quarantine");
    expect(conclusionForExitCode(1)).toBe("skipped");
  });

  // KNOWN DEFECT, PINNED AS-IS — do not "fix" this test by inventing entries.
  //
  // An earlier version of this test claimed to use "a report shaped like what
  // main() writes for a clean run" but gave it a non-empty `entries[]` holding an
  // entry with `diffs: []`. main() writes neither: entries come only from FAILED
  // assertions, and an assertion whose block parses to zero diffs is routed to the
  // unparseable/quarantine lane, so no entry is ever written with empty `diffs`.
  // A clean run (exit 0) writes `entries: []` — verified by running
  // collectDriftEntries over an all-passing result.
  //
  // With the accurate fixture the guard REJECTS it, and that is the finding the
  // invented fixture was concealing: `isBaseReportReusable` requires non-empty
  // `entries[]`, but the only conclusions it accepts are "clean"/"success", and
  // "clean" is exactly the run that has no entries. So a healthy main can never
  // supply a reusable base — every PR pays for a fresh live base run. The guard
  // conflates "empty" (main is clean: the MOST useful base, since it makes every
  // head finding new-in-head) with "malformed" (truncated/garbage cached JSON),
  // when the signal that separates them is the `conclusion`/`generatedAt` pair.
  //
  // Pinned rather than papered over: when the guard is corrected to accept a
  // conclusion-attested empty base, this test goes RED and must be updated
  // deliberately, which is the point.
  it("a clean report as main() ACTUALLY writes it is NOT reusable (known defect: reuse is dead for a healthy main)", () => {
    const timestamp = new Date().toISOString();
    const report: DriftReport = {
      timestamp,
      generatedAt: timestamp,
      conclusion: conclusionForExitCode(0),
      // What main() really writes for a clean run — no failed assertions, no entries.
      entries: [],
    };
    expect(report.conclusion, "a clean run's conclusion is known-good").toBe("clean");
    expect(
      isBaseReportReusable(report, report.conclusion, true),
      "same UTC day and a known-good conclusion, yet rejected purely for having no entries",
    ).toBe(false);
  });

  // The reuse path is reachable ONLY for a base that carries drift — i.e. when
  // main is already broken. This is the complement of the case above and is what
  // keeps the guard's non-empty branch from being untested in both directions.
  it("a base report that DOES carry drift is reusable", () => {
    const timestamp = new Date().toISOString();
    const report: DriftReport = {
      timestamp,
      generatedAt: timestamp,
      conclusion: "success",
      entries: [driftingEntry()],
    };
    expect(isBaseReportReusable(report, report.conclusion, true)).toBe(true);
  });

  it("a report WITHOUT conclusion is not reusable (documents the pre-fix gap)", () => {
    const timestamp = new Date().toISOString();
    const legacy: DriftReport = {
      timestamp,
      entries: [driftingEntry()],
    };
    // No conclusion field → falls back to undefined → not reusable.
    expect(isBaseReportReusable(legacy, legacy.conclusion, true)).toBe(false);
  });

  it("generatedAt drives sameUtcDay staleness: same-day report reuses, prior-day does not", () => {
    // Mirrors the sameUtcDay derivation the drift workflow computes from
    // report.generatedAt (.github/workflows/test-drift.yml). This locks the
    // *semantics* of generatedAt (a stale-day base is rejected), not merely that
    // the field is written. A clean report identical in every way EXCEPT its
    // generatedAt day must flip reusability.
    const sameUtcDay = (generatedAt: string, now: Date): boolean => {
      const g = new Date(generatedAt);
      return (
        g.getUTCFullYear() === now.getUTCFullYear() &&
        g.getUTCMonth() === now.getUTCMonth() &&
        g.getUTCDate() === now.getUTCDate()
      );
    };

    const now = new Date("2026-07-15T12:00:00.000Z");
    // A base that is otherwise reusable, so the ONLY variable is its UTC day.
    // Note it has to be a report that CARRIES drift — see the known-defect test
    // above: a clean (empty-entries) base is rejected outright, so it could not
    // isolate the staleness behaviour being pinned here.
    const reusableBase = (generatedAt: string): DriftReport => ({
      timestamp: generatedAt,
      generatedAt,
      conclusion: "success",
      entries: [driftingEntry()],
    });

    // Same UTC day (later hour, same date) → derivation true → reusable.
    const today = reusableBase("2026-07-15T03:00:00.000Z");
    expect(sameUtcDay(today.generatedAt!, now)).toBe(true);
    expect(isBaseReportReusable(today, today.conclusion, sameUtcDay(today.generatedAt!, now))).toBe(
      true,
    );

    // Prior UTC day → derivation false → NOT reusable, despite an otherwise
    // identical clean report. generatedAt is what makes the difference.
    const yesterday = reusableBase("2026-07-14T23:59:59.000Z");
    expect(sameUtcDay(yesterday.generatedAt!, now)).toBe(false);
    expect(
      isBaseReportReusable(
        yesterday,
        yesterday.conclusion,
        sameUtcDay(yesterday.generatedAt!, now),
      ),
    ).toBe(false);
  });
});

/**
 * Statically extract every `surface` slug that a `*.drift.ts` emitter passes as
 * the THIRD argument of `formatDriftReport(context, diffs, surface)`.
 *
 * This scans the real source via the TypeScript AST (NOT regex/text lexing — a
 * text scan would mis-hit `formatDriftReport` inside strings/comments and cannot
 * reliably pick the 3rd argument across multiline calls). Only string-literal
 * 3rd args are collected: a 2-arg call (legacy, no marker — e.g. models.drift.ts)
 * or a non-literal arg contributes no slug and is intentionally skipped.
 */
function collectEmittedSurfaceSlugs(): { slugs: Set<string>; scannedFiles: string[] } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ts = require("typescript") as typeof import("typescript");
  const driftDir = resolve(__dirname, "drift");
  const files = readdirSync(driftDir).filter((f) => f.endsWith(".drift.ts"));
  const slugs = new Set<string>();

  for (const file of files) {
    const abs = resolve(driftDir, file);
    const source = readFileSync(abs, "utf8");
    const sf = ts.createSourceFile(abs, source, ts.ScriptTarget.Latest, true);

    const visit = (node: import("typescript").Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "formatDriftReport" &&
        node.arguments.length >= 3
      ) {
        const third = node.arguments[2];
        if (ts.isStringLiteral(third) || ts.isNoSubstitutionTemplateLiteral(third)) {
          slugs.add(third.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { slugs, scannedFiles: files };
}

describe("WS-5 — SURFACE_REGISTRY coverage & integrity", () => {
  it("every slug an emitter passes to formatDriftReport is a registered surface", () => {
    // Independent derivation (F2/F3): scan the ACTUAL emitter call sites rather
    // than iterating the registry's own keys (which is a tautology). This locks
    // the "every emitter is registered" invariant at TEST time, so a new
    // unregistered emitter fails CI even on a credential-less run where no drift
    // is ever emitted and the collector's runtime throw is never reached.
    const { slugs, scannedFiles } = collectEmittedSurfaceSlugs();
    expect(scannedFiles.length, "found *.drift.ts files to scan").toBeGreaterThan(0);
    expect(slugs.size, "found at least one emitted surface slug").toBeGreaterThan(0);

    const unregistered = [...slugs].filter((slug) => !isKnownSurface(slug));
    expect(
      unregistered,
      `emitter slug(s) missing from SURFACE_REGISTRY: ${unregistered.join(", ")}`,
    ).toEqual([]);
  });

  it("SURFACE_REGISTRY has no orphan slugs (every registered surface is emitted)", () => {
    // Reverse direction: an entry no emitter uses is dead weight. Kept as a
    // separate assertion so a future intentional pre-registration is easy to see.
    const { slugs } = collectEmittedSurfaceSlugs();
    const orphans = KNOWN_SURFACE_SLUGS.filter((slug) => !slugs.has(slug));
    expect(orphans, `registered but never emitted: ${orphans.join(", ")}`).toEqual([]);
  });

  it("every registry entry resolves to an existing builderFile with non-empty builderFunctions", () => {
    // Mirrors the fix-drift.ts validation so a bad entry fails locally, not in CI.
    const repoRoot = resolve(__dirname, "..", "..");
    for (const [slug, mapping] of Object.entries(SURFACE_REGISTRY)) {
      expect(mapping.provider.length, `${slug} provider`).toBeGreaterThan(0);
      expect(mapping.builderFunctions.length, `${slug} builderFunctions`).toBeGreaterThan(0);
      expect(
        mapping.builderFunctions.every((f) => typeof f === "string" && f.length > 0),
        `${slug} builderFunctions all non-empty strings`,
      ).toBe(true);
      const abs = resolve(repoRoot, mapping.builderFile);
      expect(existsSync(abs), `${slug} builderFile exists: ${mapping.builderFile}`).toBe(true);
      if (mapping.typesFile !== null) {
        expect(
          existsSync(resolve(repoRoot, mapping.typesFile)),
          `${slug} typesFile exists: ${mapping.typesFile}`,
        ).toBe(true);
      }
    }
  });

  it("provider labels are unique (legacy fallback reverse-index has no collisions)", () => {
    const labels = Object.values(SURFACE_REGISTRY).map((m) => m.provider);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
