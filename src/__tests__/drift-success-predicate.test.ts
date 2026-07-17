/**
 * Tests for the WS-2 drift-success predicate.
 *
 * These exercise the REAL exported pure function `evaluateDriftResolved` and
 * the CLI helpers from scripts/drift-success-predicate.ts. The predicate is a
 * pure function over a small `DriftReport` fixture + a synthetic changed-file
 * array — no live API, no LLM, no aimock needed.
 *
 * The headline case is the fixture-relaxation cheat: a run that changes ONLY
 * `src/__tests__/drift/sdk-shapes.ts` (relaxing the SDK leg) must be REJECTED
 * (COMPARISON_LEG_ONLY), whereas the OLD fix-drift.ts guard (`builderFiles>0 ||
 * testFiles>0`) would have ACCEPTED it — demonstrated by contrast below.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import type { DriftEntry, DriftReport, ParsedDiff } from "../../scripts/drift-types.js";
import {
  evaluateDriftResolved,
  PredicateReason,
  REASON_EXIT_CODE,
  isProductionFile,
  isComparisonLeg,
  isSuppressionSurface,
  isGameableLeg,
  sanctionedTargets,
  countCriticalDiffs,
  parseCliArgs,
  parsePorcelainLine,
  crossCheckChangedFiles,
  PredicateConfigError,
  readReport,
  runCli,
} from "../../scripts/drift-success-predicate.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function diff(overrides: Partial<ParsedDiff> = {}): ParsedDiff {
  return {
    path: "choices[0].message.content",
    severity: "critical",
    issue: "field present in SDK+real but missing from mock",
    expected: "string",
    real: "string",
    mock: "<missing>",
    ...overrides,
  };
}

function entry(overrides: Partial<DriftEntry> = {}): DriftEntry {
  return {
    provider: "OpenAI",
    scenario: "chat completion",
    builderFile: "src/helpers.ts",
    builderFunctions: ["buildChatCompletion"],
    typesFile: "src/types.ts",
    sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
    diffs: [diff()],
    ...overrides,
  };
}

function report(entries: DriftEntry[] = [entry()]): DriftReport {
  return { timestamp: "2026-07-16T00:00:00.000Z", entries };
}

/** The OLD, gameable guard from fix-drift.ts:638 — for contrast assertions. */
function oldGuardWouldAccept(changedFiles: string[]): boolean {
  const builderFiles = changedFiles.filter(
    (f) => f.startsWith("src/") && !f.startsWith("src/__tests__/"),
  );
  const testFiles = changedFiles.filter((f) => f.startsWith("src/__tests__/"));
  // OLD guard aborts ONLY when BOTH are empty; otherwise it proceeds.
  return !(builderFiles.length === 0 && testFiles.length === 0);
}

// ---------------------------------------------------------------------------
// RED cases — resolved:false
// ---------------------------------------------------------------------------

describe("evaluateDriftResolved — RED (cheat/failure) cases", () => {
  it("HEADLINE: fixture-relaxation-only (sdk-shapes.ts) → COMPARISON_LEG_ONLY, and the OLD guard would have ACCEPTED it", () => {
    const changedFiles = ["src/__tests__/drift/sdk-shapes.ts"];
    const verdict = evaluateDriftResolved({
      changedFiles,
      report: report(),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });

    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.COMPARISON_LEG_ONLY);
    expect(verdict.offendingFiles).toContain("src/__tests__/drift/sdk-shapes.ts");
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(11);

    // Contrast: the OLD guard would have proceeded (testFiles non-empty).
    expect(oldGuardWouldAccept(changedFiles)).toBe(true);
  });

  it("schema/allowlist edit + real builder change → SUPPRESSION_SUSPECTED (blocks even with a prod change)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/__tests__/drift/schema.ts", "src/helpers.ts"],
      report: report(),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.SUPPRESSION_SUSPECTED);
    expect(verdict.offendingFiles).toContain("src/__tests__/drift/schema.ts");
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(12);
  });

  it("*.drift.ts assertion loosened only → SUPPRESSION_SUSPECTED", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/__tests__/drift/openai-chat.drift.ts"],
      report: report(),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.SUPPRESSION_SUSPECTED);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(12);
  });

  it("no changes at all → NO_PRODUCTION_CHANGE", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: [],
      report: report(),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.NO_PRODUCTION_CHANGE);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(10);
  });

  it("production change but collector still dirty (exit 2) → STILL_DIRTY", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts"],
      report: report(),
      postFixCollectorExit: 2,
      postFixCriticalCount: 1,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.STILL_DIRTY);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(13);
  });

  it("production change + collector exit 0 but criticalCount>0 → STILL_DIRTY (belt-and-suspenders)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts"],
      report: report(),
      postFixCollectorExit: 0,
      postFixCriticalCount: 3,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.STILL_DIRTY);
  });

  it("post-fix quarantine (exit 5) → QUARANTINE_AFTER_FIX", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts"],
      report: report(),
      postFixCollectorExit: 5,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.QUARANTINE_AFTER_FIX);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(14);
  });

  it("post-fix collector infra (exit 1) → COLLECTOR_INFRA", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts"],
      report: report(),
      postFixCollectorExit: 1,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.COLLECTOR_INFRA);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(15);
  });

  it("production change off-target → PRODUCTION_CHANGE_OFF_TARGET", () => {
    // report names src/helpers.ts; the change is an unrelated production file.
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/gemini.ts"],
      report: report([entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" })]),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.PRODUCTION_CHANGE_OFF_TARGET);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(16);
  });

  // -------------------------------------------------------------------------
  // WS-2b HYBRID CHEAT — a gameable-leg edit ACCOMPANIED by a trivial, on-target
  // production edit. Pre-fix the predicate ignored the leg once ANY production
  // file changed → RESOLVED (the exact WS-2b auto-merge cheat). Post-fix a leg
  // edit ALWAYS blocks (SUPPRESSION_SUSPECTED), regardless of production files.
  // -------------------------------------------------------------------------
  it("HEADLINE WS-2b: sdk-shapes.ts relaxation + on-target production edit → SUPPRESSION_SUSPECTED (block), NOT resolved", () => {
    const changedFiles = ["src/__tests__/drift/sdk-shapes.ts", "src/helpers.ts"];
    const verdict = evaluateDriftResolved({
      changedFiles,
      report: report([entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" })]),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.SUPPRESSION_SUSPECTED);
    expect(verdict.offendingFiles).toContain("src/__tests__/drift/sdk-shapes.ts");
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(12);
    // Contrast: the OLD guard would have proceeded (both builder + test present).
    expect(oldGuardWouldAccept(changedFiles)).toBe(true);
  });

  it("harness leg (providers.ts) relaxation + on-target production edit → SUPPRESSION_SUSPECTED (block)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/__tests__/drift/providers.ts", "src/helpers.ts"],
      report: report([entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" })]),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.SUPPRESSION_SUSPECTED);
    expect(verdict.offendingFiles).toContain("src/__tests__/drift/providers.ts");
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(12);
  });

  it("harness-only leg edit (ws-providers.ts), no production change → COMPARISON_LEG_ONLY (block, pure relaxation)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/__tests__/drift/ws-providers.ts"],
      report: report(),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    // Leg edit with NO production change → COMPARISON_LEG_ONLY (a pure
    // relaxation; no mock fix even attempted). Still a hard block (exit 11).
    expect(verdict.reason).toBe(PredicateReason.COMPARISON_LEG_ONLY);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(11);
  });

  // -------------------------------------------------------------------------
  // FIX #2 — dual-classification precedence: voice-models.ts is BOTH a harness
  // leg AND a legit fixture target. Block-classification MUST win (fail-closed).
  // -------------------------------------------------------------------------
  it("voice-models.ts (dual-classified harness+target) + on-target production edit → SUPPRESSION_SUSPECTED (block wins)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/__tests__/drift/voice-models.ts", "src/ws-realtime.ts"],
      report: report([entry({ builderFile: "src/ws-realtime.ts", typesFile: null })]),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.SUPPRESSION_SUSPECTED);
    expect(verdict.offendingFiles).toContain("src/__tests__/drift/voice-models.ts");
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(12);
  });

  // -------------------------------------------------------------------------
  // FIX #3 — empty sanctioned-target set must fail closed (needs-human), not
  // silently accept any production change by disabling the off-target guard.
  // -------------------------------------------------------------------------
  it("empty sanctionedTargets (report entries have no usable target) → PRODUCTION_CHANGE_OFF_TARGET (fail-closed)", () => {
    // Fabricate a report whose entries yield ZERO sanctioned targets: builderFile
    // "" and typesFile null. (evaluateDriftResolved does not re-validate the
    // report shape — it only reads builderFile/typesFile via sanctionedTargets.)
    const emptyTargetReport: DriftReport = {
      timestamp: "2026-07-16T00:00:00.000Z",
      entries: [
        {
          provider: "OpenAI",
          scenario: "chat completion",
          builderFile: "",
          builderFunctions: ["buildChatCompletion"],
          typesFile: null,
          sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
          diffs: [diff()],
        },
      ],
    };
    expect(sanctionedTargets(emptyTargetReport).size).toBe(0);
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts"],
      report: emptyTargetReport,
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.PRODUCTION_CHANGE_OFF_TARGET);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(16);
  });

  // -------------------------------------------------------------------------
  // FIX #6 — exit 5/1 WITH parseable criticalCount>0 gets its OWN reason
  // (quarantine/infra), NOT STILL_DIRTY. The collector-state classification
  // wins over the belt-and-suspenders criticalCount check.
  // -------------------------------------------------------------------------
  it("post-fix quarantine (exit 5) with criticalCount>0 → QUARANTINE_AFTER_FIX (not STILL_DIRTY)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts"],
      report: report(),
      postFixCollectorExit: 5,
      postFixCriticalCount: 4,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.QUARANTINE_AFTER_FIX);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(14);
  });

  it("post-fix infra (exit 1) with criticalCount>0 → COLLECTOR_INFRA (not STILL_DIRTY)", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts"],
      report: report(),
      postFixCollectorExit: 1,
      postFixCriticalCount: 4,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.COLLECTOR_INFRA);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// GREEN cases — resolved:true
// ---------------------------------------------------------------------------

describe("evaluateDriftResolved — GREEN (real fix) cases", () => {
  it("real src/helpers.ts fix + clean collector → RESOLVED", () => {
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/helpers.ts", "src/types.ts"],
      report: report([entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" })]),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(true);
    expect(verdict.reason).toBe(PredicateReason.RESOLVED);
    expect(REASON_EXIT_CODE[verdict.reason]).toBe(0);
  });

  it("legit canary: model-registry.ts + ws-realtime.ts (report sanctions ws-realtime.ts) → RESOLVED", () => {
    // The known-models canary routes its fix to the production ws-realtime.ts
    // (builderFile), while the model list lives in the model-registry fixture.
    const canary = report([
      entry({
        provider: "OpenAI Realtime",
        scenario: "known-models canary",
        builderFile: "src/ws-realtime.ts",
        builderFunctions: ["buildRealtimeSession"],
        typesFile: null,
        diffs: [
          diff({ path: "knownModels", issue: "Unknown realtime model detected", mock: "<none>" }),
        ],
      }),
    ]);
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/__tests__/drift/model-registry.ts", "src/ws-realtime.ts"],
      report: canary,
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(true);
    expect(verdict.reason).toBe(PredicateReason.RESOLVED);
  });

  it("AG-UI: report names src/agui-types.ts; change to that file → RESOLVED", () => {
    const agui = report([
      entry({
        provider: "AG-UI",
        scenario: "missing event types",
        builderFile: "src/agui-types.ts",
        builderFunctions: ["AGUIEventType"],
        typesFile: "src/agui-types.ts",
        sdkShapesFile: "src/__tests__/drift/agui-schema.drift.ts",
        diffs: [diff({ path: "AGUIEventType", issue: "missing event type" })],
      }),
    ]);
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/agui-types.ts"],
      report: agui,
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(true);
    expect(verdict.reason).toBe(PredicateReason.RESOLVED);
  });

  it("production change + accompanying legit canary fixture (not a comparison leg) → RESOLVED", () => {
    // model-family.ts is a legit fixture target, not a gameable comparison leg,
    // so accompanying a real production change it does not trip the cheat guard.
    const verdict = evaluateDriftResolved({
      changedFiles: ["src/ws-realtime.ts", "src/__tests__/drift/model-family.ts"],
      report: report([entry({ builderFile: "src/ws-realtime.ts", typesFile: null })]),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(true);
    expect(verdict.reason).toBe(PredicateReason.RESOLVED);
  });
});

// ---------------------------------------------------------------------------
// File-classification unit coverage
// ---------------------------------------------------------------------------

describe("file classification", () => {
  it("isProductionFile matches src/** except src/__tests__/**", () => {
    expect(isProductionFile("src/helpers.ts")).toBe(true);
    expect(isProductionFile("src/agui-types.ts")).toBe(true);
    expect(isProductionFile("src/__tests__/drift/sdk-shapes.ts")).toBe(false);
    expect(isProductionFile("scripts/fix-drift.ts")).toBe(false);
  });

  it("isComparisonLeg flags SDK/schema/harness/*.drift.ts (incl dual-classified voice-models) but NOT pure legit targets", () => {
    expect(isComparisonLeg("src/__tests__/drift/sdk-shapes.ts")).toBe(true);
    expect(isComparisonLeg("src/__tests__/drift/schema.ts")).toBe(true);
    expect(isComparisonLeg("src/__tests__/drift/providers.ts")).toBe(true);
    expect(isComparisonLeg("src/__tests__/drift/ws-providers.ts")).toBe(true);
    expect(isComparisonLeg("src/__tests__/drift/helpers.ts")).toBe(true);
    expect(isComparisonLeg("src/__tests__/drift/openai-chat.drift.ts")).toBe(true);
    // Dual-classified voice-models.ts blocks (fix #2: harness membership wins).
    expect(isComparisonLeg("src/__tests__/drift/voice-models.ts")).toBe(true);
    // PURE legit fixture targets (not also a harness leg) are NOT comparison legs.
    expect(isComparisonLeg("src/__tests__/drift/model-registry.ts")).toBe(false);
    expect(isComparisonLeg("src/__tests__/drift/model-family.ts")).toBe(false);
    // Production files are not comparison legs.
    expect(isComparisonLeg("src/helpers.ts")).toBe(false);
  });

  it("isSuppressionSurface flags the NARROW always-suppress set (schema + *.drift.ts) only", () => {
    // Suppression surface = the actively-silencing subset: schema/allowlist and
    // *.drift.ts assertions. These always map to SUPPRESSION_SUSPECTED. The
    // broader legs (sdk-shapes / harness) are gameable but are NOT suppression
    // surfaces (they map to COMPARISON_LEG_ONLY when standalone).
    expect(isSuppressionSurface("src/__tests__/drift/schema.ts")).toBe(true);
    expect(isSuppressionSurface("src/__tests__/drift/openai-chat.drift.ts")).toBe(true);
    expect(isSuppressionSurface("src/__tests__/drift/sdk-shapes.ts")).toBe(false);
    expect(isSuppressionSurface("src/__tests__/drift/providers.ts")).toBe(false);
    expect(isSuppressionSurface("src/__tests__/drift/voice-models.ts")).toBe(false);
    expect(isSuppressionSurface("src/helpers.ts")).toBe(false);
  });

  it("isGameableLeg flags every leg (incl dual-classified voice-models) but NOT model-registry/model-family/production", () => {
    expect(isGameableLeg("src/__tests__/drift/sdk-shapes.ts")).toBe(true);
    expect(isGameableLeg("src/__tests__/drift/schema.ts")).toBe(true);
    expect(isGameableLeg("src/__tests__/drift/providers.ts")).toBe(true);
    expect(isGameableLeg("src/__tests__/drift/ws-providers.ts")).toBe(true);
    expect(isGameableLeg("src/__tests__/drift/helpers.ts")).toBe(true);
    expect(isGameableLeg("src/__tests__/drift/openai-chat.drift.ts")).toBe(true);
    // Dual-classified: harness membership wins over legit-target (fix #2).
    expect(isGameableLeg("src/__tests__/drift/voice-models.ts")).toBe(true);
    // Pure legit fixture targets are NOT gameable legs.
    expect(isGameableLeg("src/__tests__/drift/model-registry.ts")).toBe(false);
    expect(isGameableLeg("src/__tests__/drift/model-family.ts")).toBe(false);
    expect(isGameableLeg("src/helpers.ts")).toBe(false);
  });

  it("sanctionedTargets unions builderFile + non-null typesFile", () => {
    const t = sanctionedTargets(
      report([
        entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" }),
        entry({ builderFile: "src/gemini.ts", typesFile: null }),
      ]),
    );
    expect(t.has("src/helpers.ts")).toBe(true);
    expect(t.has("src/types.ts")).toBe(true);
    expect(t.has("src/gemini.ts")).toBe(true);
    expect(t.has("src/__tests__/drift/sdk-shapes.ts")).toBe(false);
  });

  it("countCriticalDiffs counts only critical severities", () => {
    const r = report([
      entry({
        diffs: [
          diff({ severity: "critical" }),
          diff({ severity: "warning" }),
          diff({ severity: "critical" }),
        ],
      }),
    ]);
    expect(countCriticalDiffs(r)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// CLI arg parsing + config errors (exit 2)
// ---------------------------------------------------------------------------

describe("parseCliArgs", () => {
  it("parses a full valid arg set", () => {
    const args = parseCliArgs([
      "--report",
      "a.json",
      "--post-fix-report",
      "b.json",
      "--post-fix-exit",
      "0",
      "--changed-file",
      "src/helpers.ts",
      "--changed-file",
      "src/types.ts",
    ]);
    expect(args.reportPath).toBe("a.json");
    expect(args.postFixReportPath).toBe("b.json");
    expect(args.postFixExit).toBe(0);
    expect(args.changedFiles).toEqual(["src/helpers.ts", "src/types.ts"]);
  });

  it("null changedFiles when no --changed-file flag (derive from git later)", () => {
    const args = parseCliArgs([
      "--report",
      "a.json",
      "--post-fix-report",
      "b.json",
      "--post-fix-exit",
      "2",
    ]);
    expect(args.changedFiles).toBeNull();
  });

  it("throws on missing --report", () => {
    expect(() => parseCliArgs(["--post-fix-report", "b.json", "--post-fix-exit", "0"])).toThrow(
      PredicateConfigError,
    );
  });

  it("throws on non-integer --post-fix-exit", () => {
    expect(() =>
      parseCliArgs(["--report", "a.json", "--post-fix-report", "b.json", "--post-fix-exit", "abc"]),
    ).toThrow(PredicateConfigError);
  });

  it("throws on unknown argument", () => {
    expect(() => parseCliArgs(["--nope"])).toThrow(PredicateConfigError);
  });
});

describe("readReport", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("throws PredicateConfigError on a missing file", () => {
    expect(() => readReport("/no/such/drift-report.json")).toThrow(PredicateConfigError);
  });

  // FIX #6 — align the strict/loose validators. readReport must fail-closed on a
  // structurally-untrustworthy report the same way fix-drift.ts:readDriftReport
  // does: a missing/non-string `timestamp` is a corrupt/truncated collector run
  // and must be REJECTED, never silently trusted as a clean signal.
  it("rejects a report missing the timestamp field (fail-closed, aligns with readDriftReport)", () => {
    dir = mkdtempSync(join(tmpdir(), "ws2-readreport-"));
    const p = join(dir, "no-ts.json");
    writeFileSync(p, JSON.stringify({ entries: [] }), "utf-8");
    expect(() => readReport(p)).toThrow(PredicateConfigError);
  });

  it("rejects a non-object / non-{entries:[]} structure", () => {
    dir = mkdtempSync(join(tmpdir(), "ws2-readreport-"));
    const p = join(dir, "bad.json");
    writeFileSync(p, JSON.stringify({ timestamp: "t", entries: "nope" }), "utf-8");
    expect(() => readReport(p)).toThrow(PredicateConfigError);
  });

  // A legitimately-clean post-fix report IS { entries: [] } — the collector
  // emits exactly that when no drift remains. It must be ACCEPTED (the trust
  // anchor for "clean" is the collector EXIT CODE, corroborated by fix #1's
  // always-block-on-leg-edit rule, not the entries array being non-empty).
  it("accepts a well-formed EMPTY report (the genuine clean-collector signal)", () => {
    dir = mkdtempSync(join(tmpdir(), "ws2-readreport-"));
    const p = join(dir, "clean.json");
    writeFileSync(p, JSON.stringify({ timestamp: "t", entries: [] }), "utf-8");
    expect(() => readReport(p)).not.toThrow();
  });

  it("accepts a well-formed non-empty report", () => {
    dir = mkdtempSync(join(tmpdir(), "ws2-readreport-"));
    const p = join(dir, "ok.json");
    writeFileSync(p, JSON.stringify(report()), "utf-8");
    expect(() => readReport(p)).not.toThrow();
  });
});

describe("parsePorcelainLine", () => {
  it("strips the 2-char status + space prefix", () => {
    expect(parsePorcelainLine(" M src/helpers.ts")).toBe("src/helpers.ts");
    expect(parsePorcelainLine("?? src/new.ts")).toBe("src/new.ts");
    expect(parsePorcelainLine("A  src/added.ts")).toBe("src/added.ts");
  });

  it("takes the NEW path from rename notation (old -> new)", () => {
    expect(parsePorcelainLine("R  src/old.ts -> src/new.ts")).toBe("src/new.ts");
  });

  it("unquotes paths with special characters", () => {
    expect(parsePorcelainLine('?? "src/weird name.ts"')).toBe("src/weird name.ts");
    expect(parsePorcelainLine('R  "src/old x.ts" -> "src/new x.ts"')).toBe("src/new x.ts");
  });
});

// ---------------------------------------------------------------------------
// runCli end-to-end (in-process): exit codes over real temp report files
// ---------------------------------------------------------------------------

describe("runCli", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function writeReports(pre: DriftReport, post: DriftReport): { pre: string; post: string } {
    dir = mkdtempSync(join(tmpdir(), "ws2-predicate-"));
    const preP = join(dir, "drift-report.json");
    const postP = join(dir, "drift-report.post-fix.json");
    writeFileSync(preP, JSON.stringify(pre), "utf-8");
    writeFileSync(postP, JSON.stringify(post), "utf-8");
    return { pre: preP, post: postP };
  }

  // NOTE (fix #4): runCli now ALWAYS cross-checks any --changed-file list
  // against the real git working tree, so a synthetic list that does not match
  // the checkout is rejected (exit 2) BEFORE the predicate runs. The exit-code-
  // per-reason mapping for the cheat / real-fix cases is covered directly by the
  // evaluateDriftResolved + REASON_EXIT_CODE tests above; here we lock the
  // cross-check itself (the fix #4 blinding guard) at the runCli boundary.
  it("exits 2 (CONFIG_ERROR) when --changed-file disagrees with git (fix #4 blinding guard)", () => {
    const paths = writeReports(report(), report([]));
    const code = runCli([
      "--report",
      paths.pre,
      "--post-fix-report",
      paths.post,
      "--post-fix-exit",
      "0",
      "--changed-file",
      "src/__tests__/drift/sdk-shapes.ts",
    ]);
    expect(code).toBe(2);
  });

  it("exits 2 (CONFIG_ERROR) on a missing post-fix report", () => {
    const paths = writeReports(report(), report());
    const code = runCli([
      "--report",
      paths.pre,
      "--post-fix-report",
      join(dir!, "does-not-exist.json"),
      "--post-fix-exit",
      "0",
      "--changed-file",
      "src/helpers.ts",
    ]);
    expect(code).toBe(2);
  });

  it("exits 2 (CONFIG_ERROR) on malformed args", () => {
    const code = runCli(["--bogus"]);
    expect(code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// FIX #4 — authoritative changed-files: crossCheckChangedFiles
// ---------------------------------------------------------------------------

describe("crossCheckChangedFiles", () => {
  it("returns the git set when no explicit list is supplied", () => {
    const git = ["src/helpers.ts", "src/types.ts"];
    expect(crossCheckChangedFiles(null, git)).toEqual(git);
  });

  it("accepts an explicit list that matches the git set (order-independent)", () => {
    const git = ["src/helpers.ts", "src/types.ts"];
    expect(crossCheckChangedFiles(["src/types.ts", "src/helpers.ts"], git)).toEqual(
      expect.arrayContaining(git),
    );
  });

  it("throws when the explicit list OMITS a file git reports (leg-blinding attack)", () => {
    const git = ["src/helpers.ts", "src/__tests__/drift/sdk-shapes.ts"];
    // Attacker passes only the benign production file, hiding the relaxed leg.
    expect(() => crossCheckChangedFiles(["src/helpers.ts"], git)).toThrow(PredicateConfigError);
  });

  it("throws when the explicit list ADDS a file git does not report", () => {
    const git = ["src/helpers.ts"];
    expect(() => crossCheckChangedFiles(["src/helpers.ts", "src/phantom.ts"], git)).toThrow(
      PredicateConfigError,
    );
  });
});

// ---------------------------------------------------------------------------
// REVERT GUARD + RED-COUNT LOCK
// ---------------------------------------------------------------------------

describe("revert guard — old always-accept predicate would FAIL these locks", () => {
  // The pre-hardening predicate ignored gameable legs once ANY production file
  // changed (and had a legacy always-accept fallback). This models that old
  // behavior; asserting it DISAGREES with the real predicate on the WS-2b cheat
  // proves the hardening is load-bearing. If someone reverts evaluateDriftResolved
  // to the old logic, the HEADLINE WS-2b test above flips and the suite breaks.
  function oldPredicateWouldAccept(changedFiles: string[]): boolean {
    const productionFiles = changedFiles.filter(isProductionFile);
    // Old logic: leg files only checked when productionFiles === 0.
    return productionFiles.length > 0;
  }

  it("WS-2b cheat: old predicate ACCEPTS, real predicate BLOCKS (SUPPRESSION_SUSPECTED)", () => {
    const cheat = ["src/__tests__/drift/sdk-shapes.ts", "src/helpers.ts"];
    // Old behavior would have accepted (a production file is present).
    expect(oldPredicateWouldAccept(cheat)).toBe(true);
    // Real predicate blocks.
    const verdict = evaluateDriftResolved({
      changedFiles: cheat,
      report: report([entry({ builderFile: "src/helpers.ts", typesFile: "src/types.ts" })]),
      postFixCollectorExit: 0,
      postFixCriticalCount: 0,
    });
    expect(verdict.resolved).toBe(false);
    expect(verdict.reason).toBe(PredicateReason.SUPPRESSION_SUSPECTED);
  });
});

describe("RED-count lock", () => {
  // A structural lock: exactly this many distinct block reasons must reject.
  // NOTE: the current RED-case count in the top describe block is 9 (NOT 10) —
  // HEADLINE, schema+builder, *.drift.ts, no-change, still-dirty(exit2),
  // criticalCount>0, quarantine, infra, off-target. The WS-2b / dual-class /
  // empty-targets / exit5+critical / exit1+critical additions raise the total.
  const BLOCK_REASONS = [
    PredicateReason.NO_PRODUCTION_CHANGE,
    PredicateReason.COMPARISON_LEG_ONLY,
    PredicateReason.SUPPRESSION_SUSPECTED,
    PredicateReason.STILL_DIRTY,
    PredicateReason.QUARANTINE_AFTER_FIX,
    PredicateReason.COLLECTOR_INFRA,
    PredicateReason.PRODUCTION_CHANGE_OFF_TARGET,
    PredicateReason.CONFIG_ERROR,
  ];

  it("every block reason has a distinct non-zero exit code and RESOLVED is 0", () => {
    expect(REASON_EXIT_CODE[PredicateReason.RESOLVED]).toBe(0);
    const codes = BLOCK_REASONS.map((r) => REASON_EXIT_CODE[r]);
    for (const c of codes) expect(c).not.toBe(0);
    expect(new Set(codes).size).toBe(codes.length); // all distinct
  });
});
