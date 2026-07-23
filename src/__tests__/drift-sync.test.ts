/**
 * Characterization tests for the C1 plumbing MOVE (fix-drift.ts → drift-sync.ts).
 *
 * The reusable git / branch / commit / PR plumbing was extracted VERBATIM into
 * scripts/drift-sync.ts so the deterministic model-sync path can reuse it.
 *
 * C3 (delete-freewriter-predicate-rewire): `scripts/fix-drift.ts` — the LLM
 * freewriter invocation + its predicate-gated CLI, which used to re-export
 * this plumbing as a pass-through so its own tests kept working unchanged —
 * has been DELETED entirely. The re-export-identity half of this suite (which
 * asserted `fix-drift.js`'s bindings were identical to `drift-sync.js`'s own)
 * no longer has a module to compare against and is dropped. What remains locks
 * that the moved pure functions behave correctly at drift-sync.ts's own module
 * boundary (now the only boundary).
 */
import { describe, it, expect } from "vitest";

import type { DriftReport } from "../../scripts/drift-types.js";
import * as sync from "../../scripts/drift-sync.js";

// ---------------------------------------------------------------------------
// Behavior at the drift-sync.ts module boundary (pure functions only).
// ---------------------------------------------------------------------------

describe("drift-sync pure plumbing behaves the same at the new boundary", () => {
  it("todayStamp returns a YYYY-MM-DD stamp", () => {
    expect(sync.todayStamp()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("truncateBody passes through under the limit and marks over-limit bodies", () => {
    expect(sync.truncateBody("hello", 60000)).toBe("hello");
    const out = sync.truncateBody("a".repeat(70000));
    expect(out.length).toBeLessThanOrEqual(sync.GH_BODY_SAFE_MAX);
    expect(out).toContain("Body truncated");
  });

  it("parsePorcelainLine handles quoted + rename notation", () => {
    expect(sync.parsePorcelainLine(" M src/foo.ts")).toBe("src/foo.ts");
    expect(sync.parsePorcelainLine("R  old.ts -> new.ts")).toBe("new.ts");
    expect(sync.parsePorcelainLine(' M "src/special chars.ts"')).toBe("src/special chars.ts");
  });

  it("affectedSkillSections maps + dedupes + sorts builder files", () => {
    expect(sync.affectedSkillSections(["src/bedrock.ts", "src/bedrock-converse.ts"])).toEqual([
      "Bedrock",
    ]);
    expect(sync.affectedSkillSections(["package.json"])).toEqual([]);
  });

  it("gatedCommitFiles partitions production / report-named / straggler", () => {
    const sanctioned = new Set(["src/helpers.ts", "src/__tests__/drift/model-registry.ts"]);
    const g = sync.gatedCommitFiles(
      ["src/helpers.ts", "src/__tests__/drift/model-registry.ts", "weird-root-file.txt"],
      sanctioned,
    );
    expect(g.builderFiles).toEqual(["src/helpers.ts"]);
    expect(g.testFiles).toEqual(["src/__tests__/drift/model-registry.ts"]);
    expect(g.stragglers).toEqual(["weird-root-file.txt"]);
  });

  it("buildPrBody renders the summary + providers + diffs from a report", () => {
    const report: DriftReport = {
      timestamp: "2026-07-22T00:00:00.000Z",
      entries: [
        {
          provider: "openai",
          scenario: "streaming",
          builderFile: "src/helpers.ts",
          builderFunctions: ["buildChatCompletion"],
          typesFile: null,
          sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
          diffs: [
            {
              path: "response.id",
              severity: "warning",
              issue: "field missing",
              expected: "string",
              real: '"x"',
              mock: "undefined",
            },
          ],
        },
      ],
    };
    const body = sync.buildPrBody(report);
    expect(body).toContain("## Summary");
    expect(body).toContain("- openai: streaming");
    expect(body).toContain("- `response.id`: field missing");
  });
});
