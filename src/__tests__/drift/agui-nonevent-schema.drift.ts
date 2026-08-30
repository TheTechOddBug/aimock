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
import type { AGUIInterrupt, AGUIMessage } from "../../agui-types.js";

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

const canonicalExists = fs.existsSync(CANONICAL_TYPES_PATH);
const aimockExists = fs.existsSync(AIMOCK_TYPES_PATH);

describe.skipIf(!canonicalExists || !aimockExists)("AG-UI non-event schema drift", () => {
  const canonicalSource = canonicalExists ? fs.readFileSync(CANONICAL_TYPES_PATH, "utf-8") : "";
  const aimockSource = aimockExists ? fs.readFileSync(AIMOCK_TYPES_PATH, "utf-8") : "";

  it("has both sources available", () => {
    expect(canonicalExists).toBe(true);
    expect(aimockExists).toBe(true);
  });

  it("parses the canonical non-event schemas it compares", () => {
    // Positive control: a mirror silently going unparsed would make the drift
    // assertion below vacuously green.
    for (const { canonical } of MIRRORS) {
      expect(canonicalSchemaBody(canonicalSource, canonical), `${canonical} body`).toBeTruthy();
    }
    for (const { aimock } of new Map(MIRRORS.map((m) => [m.aimock, m])).values()) {
      expect(aimockInterfaceBody(aimockSource, aimock), `${aimock} body`).toBeTruthy();
    }
    // The canonical field must actually be declared where we expect to read it,
    // so an upstream rename fails loudly here instead of reading as "no drift".
    expect(canonicalSchemaBody(canonicalSource, "InterruptSchema")).toContain("subagentRunId");
  });

  it("mirrors canonical subagentRunId onto the non-event interfaces", () => {
    const drifts: string[] = [];

    for (const { canonical, aimock } of MIRRORS) {
      const canonicalBody = canonicalSchemaBody(canonicalSource, canonical);
      const aimockBody = aimockInterfaceBody(aimockSource, aimock);
      if (canonicalBody === null || aimockBody === null) continue; // reported above
      if (!/^\s*subagentRunId\s*:/m.test(canonicalBody)) continue;

      if (!/^\s*subagentRunId\?\s*:\s*string;/m.test(aimockBody)) {
        drifts.push(
          `${canonical} declares optional "subagentRunId" but aimock's ${aimock} does not mirror it`,
        );
      }
    }

    expect(drifts, `Non-event subagent attribution drift:\n  ${drifts.join("\n  ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Type-level guard. The structural check above reads source text; this one
// fails the typecheck instead, so removing the field breaks consumers loudly
// even if the ag-ui checkout is absent and the suite above skips.
//
// NOTE: tsconfig.json excludes src/__tests__, so `pnpm build` does NOT cover
// this. Typecheck it explicitly:
//   npx tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext \
//     --target ES2022 src/__tests__/drift/agui-nonevent-schema.drift.ts
// ---------------------------------------------------------------------------

describe("non-event subagent attribution is expressible in the type system", () => {
  it("accepts subagentRunId on a message and on an interrupt", () => {
    // Object literals, so excess-property checking rejects these at compile
    // time if the field is not declared.
    const message: AGUIMessage = {
      id: "msg_1",
      role: "assistant",
      content: "hi",
      subagentRunId: "sub_1",
    };
    const interrupt: AGUIInterrupt = {
      id: "int_1",
      reason: "approval",
      subagentRunId: "sub_1",
    };

    expect(message.subagentRunId).toBe("sub_1");
    expect(interrupt.subagentRunId).toBe("sub_1");
  });
});
