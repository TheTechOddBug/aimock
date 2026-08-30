/**
 * AG-UI non-event schema drift test.
 *
 * The sibling `agui-schema.drift.ts` only walks `*EventSchema` against
 * `AGUI*Event` interfaces, so drift in the non-event types — messages,
 * interrupts, tool calls — is invisible to it. This file closes that gap for
 * subagent attribution specifically: canonical `subagentRunId` is what lets a
 * client group replayed content under the subagent that produced it, and a
 * fixture whose message or interrupt silently drops the field replays as
 * root-attributed work.
 *
 * Scoped to `subagentRunId` on purpose. A general field-by-field comparison of
 * the non-event types is a larger surface (aimock deliberately flattens the
 * seven canonical message schemas into one `AGUIMessage`) and is tracked
 * separately.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const CANONICAL_TYPES_PATH = path.resolve(
  import.meta.dirname,
  "../../../../ag-ui/sdks/typescript/packages/core/src/types.ts",
);
const AIMOCK_TYPES_PATH = path.resolve(import.meta.dirname, "../../agui-types.ts");

/**
 * Read the brace-balanced body that follows the first match of `header`.
 *
 * Balancing rather than a non-greedy `\{([\s\S]*?)\}`: both sides nest braces
 * — canonical wraps schemas in `z.object({...})` chains, and aimock's
 * `AGUIToolCall` declares an inline `function: { ... }` object type — so a
 * lazy match stops at the first inner close brace.
 */
function readBlock(source: string, header: RegExp): string | null {
  const match = source.match(header);
  if (!match || match.index === undefined) return null;
  const open = source.indexOf("{", match.index + match[0].length - 1);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  return null;
}

function canonicalSchemaBody(source: string, schemaName: string): string | null {
  return readBlock(
    source,
    new RegExp(`export const ${schemaName}\\s*=\\s*z\\s*\\.\\s*object\\(\\{`),
  );
}

function aimockInterfaceBody(source: string, interfaceName: string): string | null {
  return readBlock(source, new RegExp(`export interface ${interfaceName}\\s*\\{`));
}

/**
 * Canonical schema -> the aimock interface that mirrors it.
 *
 * Aimock flattens the canonical message union into a single `AGUIMessage`
 * discriminated by `role`, so all four canonical message schemas that carry
 * `subagentRunId` map onto that one interface.
 */
const MIRRORS: Array<{ canonical: string; aimock: string }> = [
  { canonical: "BaseMessageSchema", aimock: "AGUIMessage" },
  { canonical: "ToolMessageSchema", aimock: "AGUIMessage" },
  { canonical: "ActivityMessageSchema", aimock: "AGUIMessage" },
  { canonical: "ReasoningMessageSchema", aimock: "AGUIMessage" },
  { canonical: "InterruptSchema", aimock: "AGUIInterrupt" },
];

/**
 * Read a source file, returning the error rather than throwing, so the
 * availability gate below can report *which* side is missing.
 */
function readSource(file: string): { source: string; error: string | null } {
  try {
    const source = fs.readFileSync(file, "utf-8");
    if (source.trim() === "") return { source: "", error: `${file} is empty` };
    return { source, error: null };
  } catch (err: unknown) {
    return { source: "", error: err instanceof Error ? err.message : String(err) };
  }
}

const canonical = readSource(CANONICAL_TYPES_PATH);
const aimock = readSource(AIMOCK_TYPES_PATH);

/**
 * Escape hatch for a developer running `pnpm test:drift` with no sibling ag-ui
 * checkout. Deliberately inert under CI: `CI` is set by every GitHub Actions
 * runner, so the opt-out cannot be inherited by an automated lane, and a CI run
 * without the canonical checkout fails instead of reporting a clean drift check.
 */
const localOptOut =
  process.env.AIMOCK_ALLOW_MISSING_AGUI_CHECKOUT === "1" && process.env.CI !== "true";

/**
 * Availability gate. This block is deliberately NOT skipped by the same
 * condition it checks: putting the "are the sources there?" assertion inside a
 * `describe.skipIf(!sourcesThere)` — as this file originally did — makes a
 * missing canonical checkout skip the assertion that was supposed to catch it,
 * so the whole file exits 0 while comparing nothing.
 */
describe("AG-UI non-event schema sources", () => {
  it("has both schema sources available", () => {
    // aimock's own types ship in this repo; unreadable is always a hard failure.
    expect(aimock.error, `aimock types unreadable at ${AIMOCK_TYPES_PATH}: ${aimock.error}`).toBe(
      null,
    );

    if (canonical.error !== null && localOptOut) {
      console.warn(
        `AIMOCK_ALLOW_MISSING_AGUI_CHECKOUT=1: skipping AG-UI non-event drift comparison (${canonical.error}).`,
      );
      // Pin the opt-out's own precondition so it can never apply inside CI.
      expect(process.env.CI, "the missing-checkout opt-out must never apply in CI").not.toBe(
        "true",
      );
      return;
    }

    expect(
      canonical.error,
      `canonical ag-ui types unreadable at ${CANONICAL_TYPES_PATH}: ${canonical.error}. ` +
        `Clone the canonical repo next to this one (git clone --depth 1 ` +
        `https://github.com/ag-ui-protocol/ag-ui.git ../ag-ui), or set ` +
        `AIMOCK_ALLOW_MISSING_AGUI_CHECKOUT=1 to skip the comparison locally.`,
    ).toBe(null);
  });
});

const canonicalSource = canonical.source;
const aimockSource = aimock.source;

/** Matches the canonical `subagentRunId` field declaration in a zod object body. */
const CANONICAL_SUBAGENT_RUN_ID = /^\s*subagentRunId\s*:/m;
/** Matches aimock's mirrored optional field declaration. */
const AIMOCK_SUBAGENT_RUN_ID = /^\s*subagentRunId\?\s*:\s*string;/m;

// Skipped ONLY under the explicit local opt-out asserted above; a missing
// checkout without that opt-out has already failed the gate.
describe.skipIf(canonical.error !== null || aimock.error !== null)(
  "AG-UI non-event schema drift",
  () => {
    it("parses the canonical non-event schemas it compares", () => {
      // Positive control: a mirror silently going unparsed would make the drift
      // assertion below vacuously green.
      for (const { canonical: schemaName } of MIRRORS) {
        expect(canonicalSchemaBody(canonicalSource, schemaName), `${schemaName} body`).toBeTruthy();
      }
      for (const { aimock: interfaceName } of new Map(MIRRORS.map((m) => [m.aimock, m])).values()) {
        expect(
          aimockInterfaceBody(aimockSource, interfaceName),
          `${interfaceName} body`,
        ).toBeTruthy();
      }
    });

    it("mirrors canonical subagentRunId onto the non-event interfaces", () => {
      const drifts: string[] = [];

      for (const { canonical: schemaName, aimock: interfaceName } of MIRRORS) {
        const canonicalBody = canonicalSchemaBody(canonicalSource, schemaName);
        const aimockBody = aimockInterfaceBody(aimockSource, interfaceName);
        if (canonicalBody === null || aimockBody === null) continue; // reported above

        // The canonical side is ASSERTED, not used as a silent precondition. An
        // upstream rename or removal of `subagentRunId` is exactly the drift this
        // file exists to catch, so `continue`-ing past it here would report the
        // rename as "no drift".
        if (!CANONICAL_SUBAGENT_RUN_ID.test(canonicalBody)) {
          drifts.push(
            `canonical ${schemaName} no longer declares "subagentRunId" — upstream renamed or ` +
              `removed it; update MIRRORS and aimock's ${interfaceName} to match`,
          );
          continue;
        }

        if (!AIMOCK_SUBAGENT_RUN_ID.test(aimockBody)) {
          drifts.push(
            `${schemaName} declares optional "subagentRunId" but aimock's ${interfaceName} does not mirror it`,
          );
        }
      }

      expect(drifts, `Non-event subagent attribution drift:\n  ${drifts.join("\n  ")}`).toEqual([]);
    });
  },
);

// A type-level companion guard used to live here. It asserted nothing at
// runtime and the `tsc` invocation its comment documented was wired into no
// script and no CI lane, so it read as a second guard while being theatre. The
// structural check above is the guard; it now runs in CI (test-drift.yml) and
// fails loudly rather than skipping when the canonical checkout is absent.
