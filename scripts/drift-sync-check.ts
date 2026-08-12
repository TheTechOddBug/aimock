/// <reference types="node" />

/**
 * Drift Sync Check — the deterministic REPLACEMENT for the 916-line LLM
 * anti-cheat predicate (`drift-success-predicate.ts`, spec §3/§6).
 *
 * `drift-sync.ts` (C2) never freewrites a fix — it only ever performs one of
 * two deterministic, data-only edits: (a) append one comment-marked family
 * literal to a `model-registry.ts` set (a recorded deprecation, or a
 * human-approved new family), or (b) drop a needs-human dedup note file
 * under `drift-proposals/`. Because the SYNC path can no longer produce an
 * arbitrary diff, verifying it is "real" no longer needs adversarial-intent
 * modeling or TS-diff parsing (the predicate's whole reason for being 916
 * lines) — it only needs three trivial, mechanical assertions:
 *
 *   1. CHANGED-FILE ALLOWLIST — every file the sync touched is either the
 *      model-registry DATA file or a `drift-proposals/` note file. Anything
 *      else (detector source, predicate, test harness, *.drift.ts, schema,
 *      sdk-shapes, CI workflow, ...) fails closed.
 *   2. CHECKSUM-PIN RE-ASSERT — P0's `logic-pin.test.ts` must still be green
 *      after the sync. Being on the allowlist above does NOT exempt
 *      `model-registry.ts` from this: a sync that mutated a frozen surface
 *      inside that file (familySet, NON_MODEL_TOKENS, PREVIEW_FAMILY, ...)
 *      is caught here even though the file itself was "allowed" to change.
 *   3. CLEAN RE-COLLECT — a fresh drift-report-collector run reports zero
 *      residual critical diffs, so a sync that claims to resolve drift but
 *      didn't is never waved through.
 *
 * No LLM, no model call, no heuristic scoring — every one of the three gates
 * above is a plain data check. A sync that fails any of them is NOT resolved
 * and no PR opens (mirrors the predicate's fail-closed contract, spec §3).
 *
 * WHAT GATE-3 IS AND IS NOT (run 31465219443, 2026-08-11). The re-collect runs
 * in the same workspace as the fix, so it can FILTER a cheat but cannot PROVE
 * correctness — that has always been its contract. What it also cannot do is
 * answer a question about an edit it has no surface for: two consecutive runs of
 * the identical changeset `74f6efa43753f7d0` (two gemini deprecations) got
 * `gate-failed` and then `ok-applied`, because gate-3's input is a fresh LIVE
 * observation of EVERY drift surface aimock has, and nothing about that is a
 * function of the changeset. So gate-3 now:
 *
 *   * is SKIPPED, with the reason recorded in the verdict, when the caller knows
 *     a re-collect cannot observe this run's edit (`skipRecollect`);
 *   * REFUSES on a positive critical finding and NAMES the diffs, so the next
 *     refusal is triageable from the log instead of being a bare count;
 *   * stops claiming "clean re-collect" for a zero it cannot believe — a
 *     quarantined or AG-UI-skipped report is reported as UNCONFIRMED, carried by
 *     gates 1 and 2 (see `reportTrustNote`).
 *
 * C5 only ADDS this script + its test. Wiring it into `fix-drift.yml` in place
 * of the "Assert drift truly resolved" step, and deleting
 * `drift-success-predicate.ts`, is C3's job.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { getChangedFiles } from "./drift-sync.js";
import type { DriftReport } from "./drift-types.js";

// ---------------------------------------------------------------------------
// Reasons / exit codes
// ---------------------------------------------------------------------------

export enum SyncCheckReason {
  OK = "ok",
  OFF_ALLOWLIST_CHANGE = "off-allowlist-change",
  PIN_CHECK_FAILED = "pin-check-failed",
  RESIDUAL_CRITICAL_DRIFT = "residual-critical-drift",
  CONFIG_ERROR = "config-error",
}

export const REASON_EXIT_CODE: Record<SyncCheckReason, number> = {
  [SyncCheckReason.OK]: 0,
  [SyncCheckReason.OFF_ALLOWLIST_CHANGE]: 20,
  [SyncCheckReason.PIN_CHECK_FAILED]: 21,
  [SyncCheckReason.RESIDUAL_CRITICAL_DRIFT]: 22,
  [SyncCheckReason.CONFIG_ERROR]: 2,
};

/** Fail-closed config error (missing report, unreadable output, etc). */
export class SyncCheckConfigError extends Error {}

// ---------------------------------------------------------------------------
// (1) Changed-file allowlist — DATA surfaces only.
// ---------------------------------------------------------------------------

/**
 * The ONLY file a sync may edit directly: the model-registry DATA file
 * (`includeFamilies`/`excludeFamilies` literal entries). It also hosts P0's
 * frozen logic surfaces — see the pin re-assert in gate (2), which still
 * blocks an edit here that touches one of those surfaces.
 */
const ALLOWED_EXACT_FILES: ReadonlySet<string> = new Set(["src/__tests__/drift/model-registry.ts"]);

/**
 * Needs-human dedup note files (C2) live under this prefix — never a code
 * file, always a plain artifact recording a genuinely-new family alert.
 */
const ALLOWED_PREFIXES: readonly string[] = ["drift-proposals/"];

/** True when `file` is on the sync's data-only allowlist. */
export function isAllowedSyncFile(file: string): boolean {
  if (ALLOWED_EXACT_FILES.has(file)) return true;
  return ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix));
}

/** Return the subset of `changedFiles` that is NOT on the allowlist. */
export function checkChangedFileAllowlist(changedFiles: string[]): string[] {
  return changedFiles.filter((file) => !isAllowedSyncFile(file));
}

// ---------------------------------------------------------------------------
// (2) Checksum-pin re-assert.
// ---------------------------------------------------------------------------

/** The exact test file P0 froze the classification logic in. Single source of truth. */
const LOGIC_PIN_TEST = "src/__tests__/drift/logic-pin.test.ts";

export interface CommandResult {
  status: number;
  output: string;
}

/** Run `file args...`, capturing stdout+stderr and the real exit status (never throws). */
export function runCommand(file: string, args: string[]): CommandResult {
  try {
    const output = execFileSync(file, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (err: unknown) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
    return { status: e.status ?? 1, output };
  }
}

export interface PinCheckResult {
  ok: boolean;
  output: string;
}

/**
 * Re-assert P0's checksum freeze after a sync by spawning vitest directly
 * against `logic-pin.test.ts` — the SAME test file, not a re-implementation
 * of its hashing, so there is exactly one source of truth for "frozen".
 */
export function runPinCheck(
  runner: (file: string, args: string[]) => CommandResult = runCommand,
): PinCheckResult {
  const { status, output } = runner("pnpm", ["exec", "vitest", "run", LOGIC_PIN_TEST]);
  return { ok: status === 0, output };
}

// ---------------------------------------------------------------------------
// (3) Clean re-collect.
// ---------------------------------------------------------------------------

const DEFAULT_RECOLLECT_OUT = "drift-report.sync-check.json";

/** One residual critical diff, identified well enough to triage without re-running anything. */
export interface CriticalDiffRef {
  provider: string;
  scenario: string;
  path: string;
  id?: string;
}

/**
 * Every `severity === "critical"` diff in a report, IDENTIFIED.
 *
 * The gate used to carry only a COUNT into its verdict, and the re-collect report
 * itself (`drift-report.sync-check.json`) is never uploaded by the workflow. So
 * `gate-failed … still reports 1 critical diff(s)` was the entire record of run
 * 31465219443 — which diff fired that morning is NOT recoverable from it. Naming
 * the diffs is what makes the next one diagnosable from the log alone.
 */
export function listCriticalDiffs(report: DriftReport): CriticalDiffRef[] {
  return report.entries.flatMap((entry) =>
    entry.diffs
      .filter((d) => d.severity === "critical")
      .map((d) => ({
        provider: entry.provider,
        scenario: entry.scenario,
        path: d.path,
        ...(d.id !== undefined ? { id: d.id } : {}),
      })),
  );
}

/** Count `severity === "critical"` diffs across every entry of a report. */
export function countCriticalDiffs(report: DriftReport): number {
  return listCriticalDiffs(report).length;
}

/** Render `listCriticalDiffs` output for a verdict detail line. */
export function formatCriticalDiffs(diffs: readonly CriticalDiffRef[]): string {
  return diffs.map((d) => `${d.provider}/${d.scenario}: ${d.id ?? d.path}`).join("; ");
}

/**
 * Can a ZERO critical count in this report be believed as "the live suite is
 * clean", or did the collector fail to make a trustworthy, complete observation?
 *
 * The collector writes `conclusion` from its own exit code
 * (`conclusionForExitCode`): "clean" (0), "critical" (2), "quarantine" (5 — a
 * failure it could not parse into a trustworthy finding) or "skipped" (1 — the
 * AG-UI drift leg could not run, so `entries` is missing that whole surface).
 * Only "clean" and "critical" are positive determinations.
 *
 * This gate used to read `entries` alone, so a quarantined or AG-UI-skipped
 * re-collect counted zero criticals and was reported as a "clean re-collect" —
 * an UNKNOWN collapsing into the answer that passes. Both mornings of the
 * 74f6efa43753f7d0 pair quarantined on the same live Gemini WS timeout, and the
 * 08-12 log claims a clean re-collect for it.
 *
 * A zero that cannot be believed does not become a REFUSAL — a refusal would red
 * an unattended cron on someone else's flaky live surface. It stops being a CLAIM:
 * the verdict says the re-collect could not confirm the edit, and gate-1 and
 * gate-2 carry it. A positive critical finding is still a refusal (see
 * `evaluateSyncCheck`) — an UNKNOWN must not veto, but a POSITIVE finding must.
 */
export function reportTrustNote(report: DriftReport): string | null {
  const quarantined = report.quarantine?.length ?? 0;
  if (quarantined > 0) {
    return `the collector quarantined ${quarantined} failure(s) it could not parse into a trustworthy finding`;
  }
  if (report.conclusion === undefined) {
    return "the report carries no `conclusion`, so the collector's own verdict on it is unknown";
  }
  if (report.conclusion === "skipped") {
    return "the collector's AG-UI drift leg could not run, so the report is missing that surface entirely";
  }
  if (report.conclusion !== "clean" && report.conclusion !== "critical") {
    return `the collector reported conclusion="${report.conclusion}", which is not a positive determination`;
  }
  return null;
}

/**
 * Run a fresh `drift-report-collector.ts` pass and read back its report. Throws
 * `SyncCheckConfigError` (fail-closed) if the collector did not produce a
 * readable report — a missing/corrupt post-sync report must never be treated
 * as an implicit "clean".
 */
export function recollect(
  runner: (file: string, args: string[]) => CommandResult = runCommand,
  outPath: string = resolve(DEFAULT_RECOLLECT_OUT),
): DriftReport {
  runner("npx", ["tsx", "scripts/drift-report-collector.ts", "--out", outPath]);
  if (!existsSync(outPath)) {
    throw new SyncCheckConfigError(`Clean re-collect did not produce a report at ${outPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(outPath, "utf-8"));
  } catch (err: unknown) {
    throw new SyncCheckConfigError(
      `Post-sync report at ${outPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as Record<string, unknown>).entries)
  ) {
    throw new SyncCheckConfigError(
      `Post-sync report at ${outPath} has invalid structure: expected { entries: [...] }`,
    );
  }
  return parsed as DriftReport;
}

// ---------------------------------------------------------------------------
// The check (composition of gates 1-3).
// ---------------------------------------------------------------------------

export interface SyncCheckDeps {
  getChangedFiles: () => string[];
  runPinCheck: () => PinCheckResult;
  recollect: () => DriftReport;
}

export interface EvaluateSyncCheckOptions {
  /**
   * Run gate-1 (allowlist) + gate-2 (pin) but SKIP gate-3 (the live
   * re-collect), because for THIS run's edit a fresh collector run cannot
   * answer the question gate-3 asks. Two such runs exist — see
   * `gate3SkipReason` in drift-sync.ts for both, with their evidence. Gate-1
   * and gate-2 remain in force: the edit is still proven data-only with the
   * frozen classification logic intact.
   */
  skipRecollect?: boolean;
  /**
   * WHY gate-3 was skipped, quoted into the verdict detail. Required whenever
   * `skipRecollect` is set: a skipped gate that does not say what it could not
   * observe reads in the log exactly like a gate that ran and passed.
   */
  skipRecollectReason?: string;
}

export interface SyncCheckVerdict {
  ok: boolean;
  reason: SyncCheckReason;
  detail: string;
  offendingFiles: string[];
}

/**
 * Evaluate the three deterministic gates in order, short-circuiting on the
 * first failure (fail-closed — no gate is skipped when an earlier one could
 * have already caught the problem, but there is no reason to pay for a live
 * re-collect once the changed-file/pin gates already refused).
 */
export function evaluateSyncCheck(
  deps: SyncCheckDeps,
  opts: EvaluateSyncCheckOptions = {},
): SyncCheckVerdict {
  const changedFiles = deps.getChangedFiles();
  const offendingFiles = checkChangedFileAllowlist(changedFiles);
  if (offendingFiles.length > 0) {
    return {
      ok: false,
      reason: SyncCheckReason.OFF_ALLOWLIST_CHANGE,
      detail: `Sync touched file(s) outside the data-only allowlist: ${offendingFiles.join(", ")}`,
      offendingFiles,
    };
  }

  const pin = deps.runPinCheck();
  if (!pin.ok) {
    return {
      ok: false,
      reason: SyncCheckReason.PIN_CHECK_FAILED,
      detail: `Frozen classification-logic checksum pin failed after sync — a pinned rule moved:\n${pin.output}`,
      offendingFiles: [],
    };
  }

  // gate-3 (live re-collect) is skipped when it cannot observe THIS run's edit —
  // see EvaluateSyncCheckOptions.skipRecollect.
  if (opts.skipRecollect) {
    // A skip with no stated reason reads in the log exactly like a gate that ran
    // and passed, so it is a CONFIG ERROR rather than a silent default: the
    // caller that turns gate-3 off must say what it could not observe.
    if (!opts.skipRecollectReason) {
      throw new SyncCheckConfigError(
        "skipRecollect was set with no skipRecollectReason — a gate that is turned off " +
          "must record why, or its verdict is indistinguishable from a gate that ran",
      );
    }
    return {
      ok: true,
      reason: SyncCheckReason.OK,
      detail:
        "drift-sync-check passed: changed files are data-only, classification pins intact " +
        `(live re-collect NOT RUN — ${opts.skipRecollectReason}; ` +
        "this edit is carried by gate-1 + gate-2, not by a re-collect)",
      offendingFiles: [],
    };
  }

  const report = deps.recollect();
  const criticalDiffs = listCriticalDiffs(report);
  if (criticalDiffs.length > 0) {
    // A POSITIVE finding, so it refuses — and it names the diffs, because a bare
    // count is not triageable after the fact (see `listCriticalDiffs`).
    return {
      ok: false,
      reason: SyncCheckReason.RESIDUAL_CRITICAL_DRIFT,
      detail:
        `Clean re-collect after sync still reports ${criticalDiffs.length} critical diff(s) — ` +
        `sync did not resolve the drift: ${formatCriticalDiffs(criticalDiffs)}`,
      offendingFiles: [],
    };
  }

  // Zero criticals. Whether that zero is BELIEVABLE is a separate question — a
  // quarantined or incomplete re-collect must not be reported as a clean one.
  const trustNote = reportTrustNote(report);
  if (trustNote !== null) {
    return {
      ok: true,
      reason: SyncCheckReason.OK,
      detail:
        "drift-sync-check passed: changed files are data-only, classification pins intact " +
        `(re-collect found no critical drift but could NOT CONFIRM the edit — ${trustNote}; ` +
        "this edit is carried by gate-1 + gate-2)",
      offendingFiles: [],
    };
  }

  return {
    ok: true,
    reason: SyncCheckReason.OK,
    detail:
      "drift-sync-check passed: changed files are data-only, classification pins intact, clean re-collect",
    offendingFiles: [],
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const REAL_DEPS: SyncCheckDeps = {
  getChangedFiles,
  runPinCheck: () => runPinCheck(),
  recollect: () => recollect(),
};

/** Run the check against real deps, printing a machine-readable `reason=` line. */
export function runCli(deps: SyncCheckDeps = REAL_DEPS): number {
  let verdict: SyncCheckVerdict;
  try {
    verdict = evaluateSyncCheck(deps);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`CONFIG_ERROR: ${msg}`);
    console.log(`reason=${SyncCheckReason.CONFIG_ERROR}`);
    return REASON_EXIT_CODE[SyncCheckReason.CONFIG_ERROR];
  }

  if (verdict.ok) {
    console.log(verdict.detail);
  } else {
    console.error(`DRIFT SYNC NOT RESOLVED [${verdict.reason}]: ${verdict.detail}`);
    if (verdict.offendingFiles.length > 0) {
      console.error(`Offending files: ${verdict.offendingFiles.join(", ")}`);
    }
  }
  console.log(`reason=${verdict.reason}`);
  return REASON_EXIT_CODE[verdict.reason];
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  process.exit(runCli());
}
