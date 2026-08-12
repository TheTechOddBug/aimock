/**
 * drift-sync-check.ts — the trivial, deterministic data-only gate that
 * REPLACES the 916-line LLM anti-cheat predicate (drift-success-predicate.ts).
 *
 * Three gates, tested independently and composed:
 *   1. changed-file allowlist (data surfaces only)
 *   2. checksum-pin re-assert (P0's logic-pin.test.ts must still be green)
 *   3. clean re-collect (post-sync report has zero residual critical diffs)
 *
 * No LLM, no model call — every assertion here is a plain data check.
 */
import { describe, it, expect, vi } from "vitest";

import {
  isAllowedSyncFile,
  checkChangedFileAllowlist,
  countCriticalDiffs,
  listCriticalDiffs,
  formatCriticalDiffs,
  reportTrustNote,
  evaluateSyncCheck,
  runPinCheck,
  recollect,
  SyncCheckReason,
  SyncCheckConfigError,
  REASON_EXIT_CODE,
  runCli,
  type SyncCheckDeps,
  type CommandResult,
} from "../../scripts/drift-sync-check.js";
import type { DriftReport } from "../../scripts/drift-types.js";

function report(criticalCounts: number[]): DriftReport {
  return {
    timestamp: "2026-07-22T00:00:00.000Z",
    entries: criticalCounts.map((n, i) => ({
      provider: `provider-${i}`,
      scenario: "scenario",
      builderFile: `src/provider-${i}.ts`,
      builderFunctions: [],
      typesFile: null,
      sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
      diffs: Array.from({ length: n }, (_, j) => ({
        path: `field-${j}`,
        severity: "critical" as const,
        issue: "missing",
        expected: "x",
        real: "y",
        mock: "z",
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Gate 1 — changed-file allowlist
// ---------------------------------------------------------------------------

describe("isAllowedSyncFile / checkChangedFileAllowlist", () => {
  it("allows the model-registry data file", () => {
    expect(isAllowedSyncFile("src/__tests__/drift/model-registry.ts")).toBe(true);
  });

  it("allows a drift-proposals note file at any depth", () => {
    expect(isAllowedSyncFile("drift-proposals/anthropic-new-family.md")).toBe(true);
    expect(isAllowedSyncFile("drift-proposals/nested/dir/note.md")).toBe(true);
  });

  it("rejects the SDK-shape fixture (the primary cheat surface)", () => {
    expect(isAllowedSyncFile("src/__tests__/drift/sdk-shapes.ts")).toBe(false);
  });

  it("rejects a *.drift.ts assertion file", () => {
    expect(isAllowedSyncFile("src/__tests__/drift/anthropic.drift.ts")).toBe(false);
  });

  it("rejects detector/predicate/collector source", () => {
    expect(isAllowedSyncFile("scripts/drift-success-predicate.ts")).toBe(false);
    expect(isAllowedSyncFile("scripts/drift-report-collector.ts")).toBe(false);
    expect(isAllowedSyncFile("scripts/drift-sync.ts")).toBe(false);
  });

  it("rejects a mock-builder production file", () => {
    expect(isAllowedSyncFile("src/messages.ts")).toBe(false);
  });

  it("rejects the CI workflow", () => {
    expect(isAllowedSyncFile(".github/workflows/fix-drift.yml")).toBe(false);
  });

  it("checkChangedFileAllowlist returns only the offenders", () => {
    const offenders = checkChangedFileAllowlist([
      "src/__tests__/drift/model-registry.ts",
      "drift-proposals/note.md",
      "scripts/drift-success-predicate.ts",
      "src/__tests__/drift/sdk-shapes.ts",
    ]);
    expect(offenders).toEqual([
      "scripts/drift-success-predicate.ts",
      "src/__tests__/drift/sdk-shapes.ts",
    ]);
  });

  it("checkChangedFileAllowlist returns [] when every file is allowed", () => {
    expect(
      checkChangedFileAllowlist(["src/__tests__/drift/model-registry.ts", "drift-proposals/x.md"]),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Gate 2 — checksum-pin re-assert
// ---------------------------------------------------------------------------

describe("runPinCheck", () => {
  it("reports ok when the injected runner exits 0", () => {
    const runner = vi.fn((): CommandResult => ({ status: 0, output: "5 passed" }));
    const result = runPinCheck(runner);
    expect(result.ok).toBe(true);
    expect(runner).toHaveBeenCalledWith("pnpm", [
      "exec",
      "vitest",
      "run",
      "src/__tests__/drift/logic-pin.test.ts",
    ]);
  });

  it("reports NOT ok when the injected runner exits non-zero (a pinned rule moved)", () => {
    const runner = vi.fn(
      (): CommandResult => ({
        status: 1,
        output: "FAIL logic-pin.test.ts > freezes NON_MODEL_TOKENS",
      }),
    );
    const result = runPinCheck(runner);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("NON_MODEL_TOKENS");
  });
});

// ---------------------------------------------------------------------------
// Gate 3 — clean re-collect
// ---------------------------------------------------------------------------

describe("countCriticalDiffs", () => {
  it("sums critical diffs across every entry", () => {
    expect(countCriticalDiffs(report([0, 2, 1]))).toBe(3);
  });

  it("is zero for an all-clean report", () => {
    expect(countCriticalDiffs(report([0, 0]))).toBe(0);
  });
});

describe("listCriticalDiffs / formatCriticalDiffs", () => {
  it("IDENTIFIES each critical diff, not just a count", () => {
    const refs = listCriticalDiffs(report([0, 2]));
    expect(refs).toEqual([
      { provider: "provider-1", scenario: "scenario", path: "field-0" },
      { provider: "provider-1", scenario: "scenario", path: "field-1" },
    ]);
  });

  it("prefers a stable `id` over the prose-coupled `path` when one exists", () => {
    const r = report([1]);
    r.entries[0].diffs[0].id = "openai-realtime:no-ga-family";
    expect(formatCriticalDiffs(listCriticalDiffs(r))).toBe(
      "provider-0/scenario: openai-realtime:no-ga-family",
    );
  });

  it("ignores non-critical diffs", () => {
    const r = report([1]);
    r.entries[0].diffs[0].severity = "warning";
    expect(listCriticalDiffs(r)).toEqual([]);
  });
});

describe("reportTrustNote — a zero that cannot be believed is not a clean re-collect", () => {
  function withConclusion(conclusion: string | undefined, quarantine?: number): DriftReport {
    const r = report([0]);
    if (conclusion !== undefined) r.conclusion = conclusion;
    if (quarantine !== undefined) {
      r.quarantine = Array.from({ length: quarantine }, (_, i) => ({
        provider: "unknown",
        testName: `t-${i}`,
        rawLocation: "",
        message: "waitUntil timeout after 30000ms",
      }));
    }
    return r;
  }

  it("trusts a positively-clean report", () => {
    expect(reportTrustNote(withConclusion("clean"))).toBeNull();
  });

  it("trusts a report whose criticals ARE the determination", () => {
    expect(reportTrustNote(withConclusion("critical"))).toBeNull();
  });

  it("does NOT trust a quarantined report (the 74f6efa43753f7d0 mornings' shape)", () => {
    expect(reportTrustNote(withConclusion("quarantine", 2))).toContain("quarantined 2 failure(s)");
  });

  it("does NOT trust a report whose AG-UI leg could not run (entries are incomplete)", () => {
    expect(reportTrustNote(withConclusion("skipped"))).toContain("AG-UI");
  });

  it("does NOT trust a report with no `conclusion` at all (UNKNOWN never passes as clean)", () => {
    expect(reportTrustNote(withConclusion(undefined))).toContain("no `conclusion`");
  });
});

describe("recollect", () => {
  it("fails closed (SyncCheckConfigError) when the collector produced no report file", () => {
    const runner = vi.fn((): CommandResult => ({ status: 0, output: "" }));
    expect(() => recollect(runner, "/nonexistent/path/does-not-exist.json")).toThrow(
      SyncCheckConfigError,
    );
  });
});

// ---------------------------------------------------------------------------
// Composition — evaluateSyncCheck
// ---------------------------------------------------------------------------

function deps(overrides: Partial<SyncCheckDeps>): SyncCheckDeps {
  return {
    getChangedFiles: () => ["src/__tests__/drift/model-registry.ts"],
    runPinCheck: () => ({ ok: true, output: "5 passed" }),
    recollect: () => report([0]),
    ...overrides,
  };
}

describe("evaluateSyncCheck — RED/GREEN value-test surface", () => {
  it("GREEN: a data-only excludeFamilies-style change on the allowlist, pins intact, clean re-collect -> PASSES", () => {
    const verdict = evaluateSyncCheck(deps({}));
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBe(SyncCheckReason.OK);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(0);
  });

  it("RED: a change touching a forbidden/source file (the detector) -> FAILS, never reaches pin/recollect", () => {
    const runPinCheck = vi.fn(() => ({ ok: true, output: "" }));
    const recollectFn = vi.fn(() => report([0]));
    const verdict = evaluateSyncCheck(
      deps({
        getChangedFiles: () => [
          "src/__tests__/drift/model-registry.ts",
          "src/__tests__/drift/models.drift.ts", // the detector source (C4)
        ],
        runPinCheck,
        recollect: recollectFn,
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(SyncCheckReason.OFF_ALLOWLIST_CHANGE);
    expect(verdict.offendingFiles).toEqual(["src/__tests__/drift/models.drift.ts"]);
    expect(REASON_EXIT_CODE[verdict.reason]).not.toBe(0);
    // fail-closed and CHEAP: never pays for the pin check or a live re-collect
    // once the allowlist has already refused.
    expect(runPinCheck).not.toHaveBeenCalled();
    expect(recollectFn).not.toHaveBeenCalled();
  });

  it("RED: a change mutating a pinned rule -> FAILS even though the touched file (model-registry.ts) is on the allowlist", () => {
    const recollectFn = vi.fn(() => report([0]));
    const verdict = evaluateSyncCheck(
      deps({
        getChangedFiles: () => ["src/__tests__/drift/model-registry.ts"],
        runPinCheck: () => ({
          ok: false,
          output: "FAIL logic-pin.test.ts > freezes NON_MODEL_TOKENS (rule widened)",
        }),
        recollect: recollectFn,
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(SyncCheckReason.PIN_CHECK_FAILED);
    expect(verdict.detail).toContain("NON_MODEL_TOKENS");
    expect(REASON_EXIT_CODE[verdict.reason]).not.toBe(0);
    // never trusts a live re-collect once a pinned rule has moved
    expect(recollectFn).not.toHaveBeenCalled();
  });

  it("RED: a clean re-collect that still reports residual critical drift -> FAILS", () => {
    const verdict = evaluateSyncCheck(
      deps({
        recollect: () => report([1]),
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(SyncCheckReason.RESIDUAL_CRITICAL_DRIFT);
    expect(verdict.detail).toContain("1 critical");
  });

  it("a refusal NAMES the residual diffs, so the log alone is triageable", () => {
    const r = report([1]);
    r.entries[0].diffs[0].id = "openai-realtime:no-ga-family";
    const verdict = evaluateSyncCheck(deps({ recollect: () => r }));
    expect(verdict.reason).toBe(SyncCheckReason.RESIDUAL_CRITICAL_DRIFT);
    expect(verdict.detail).toContain("provider-0/scenario: openai-realtime:no-ga-family");
  });

  it("a SKIPPED gate-3 says in the verdict what it could not observe", () => {
    const recollectFn = vi.fn(() => report([0]));
    const verdict = evaluateSyncCheck(deps({ recollect: recollectFn }), {
      skipRecollect: true,
      skipRecollectReason: "no live drift surface reads deprecatedFamilies",
    });
    expect(verdict.ok).toBe(true);
    expect(recollectFn).not.toHaveBeenCalled();
    expect(verdict.detail).toContain("live re-collect NOT RUN");
    expect(verdict.detail).toContain("no live drift surface reads deprecatedFamilies");
    // …and never claims the thing it did not do.
    expect(verdict.detail).not.toContain("clean re-collect");
  });

  it("an UNTRUSTWORTHY zero passes but is reported UNCONFIRMED, never as a clean re-collect", () => {
    const quarantined = report([0]);
    quarantined.conclusion = "quarantine";
    quarantined.quarantine = [
      { provider: "unknown", testName: "Gemini Live WS drift", rawLocation: "", message: "timeout" },
    ];
    const verdict = evaluateSyncCheck(deps({ recollect: () => quarantined }));
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBe(SyncCheckReason.OK);
    expect(verdict.detail).toContain("could NOT CONFIRM");
    expect(verdict.detail).not.toContain("clean re-collect");
  });

  it("a positively-clean re-collect DOES claim a clean re-collect", () => {
    const clean = report([0]);
    clean.conclusion = "clean";
    const verdict = evaluateSyncCheck(deps({ recollect: () => clean }));
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toContain("clean re-collect");
  });
});

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

describe("runCli", () => {
  it("returns exit 0 and prints reason=ok on a passing verdict", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = runCli(deps({}));
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(`reason=${SyncCheckReason.OK}`);
    logSpy.mockRestore();
  });

  it("returns a non-zero exit and prints the offending reason on a failing verdict", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = runCli(
      deps({
        getChangedFiles: () => ["scripts/drift-success-predicate.ts"],
      }),
    );
    expect(code).toBe(REASON_EXIT_CODE[SyncCheckReason.OFF_ALLOWLIST_CHANGE]);
    expect(logSpy).toHaveBeenCalledWith(`reason=${SyncCheckReason.OFF_ALLOWLIST_CHANGE}`);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("fails closed to CONFIG_ERROR when a dep throws (e.g. recollect couldn't produce a report)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = runCli(
      deps({
        recollect: () => {
          throw new SyncCheckConfigError("no report produced");
        },
      }),
    );
    expect(code).toBe(REASON_EXIT_CODE[SyncCheckReason.CONFIG_ERROR]);
    expect(logSpy).toHaveBeenCalledWith(`reason=${SyncCheckReason.CONFIG_ERROR}`);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});
