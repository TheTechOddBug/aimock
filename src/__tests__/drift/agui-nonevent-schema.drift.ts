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
 *
 * Both sides are read with the TypeScript parser (`ts.createSourceFile`,
 * syntax-only — no program, no type checker), never with regexes over the
 * source text. Every way a regex reader of this shape fails is a fail-OPEN
 * failure, which is the worst kind for a drift guard: a brace inside a comment
 * runs a hand-rolled brace counter past the end of the schema it was reading,
 * a `subagentRunId` nested one level down inside a property value masks its
 * removal from the top level, and a literal-text pin on `subagentRunId?:
 * string;` reports false drift on a reformat, a `readonly`, or a widened type.
 * The parser sees comments and strings as trivia, distinguishes a top-level
 * member from a nested one by construction, and exposes optionality and type
 * as structure rather than as text, so none of those failures are expressible
 * here.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const CANONICAL_TYPES_PATH = path.resolve(
  import.meta.dirname,
  "../../../../ag-ui/sdks/typescript/packages/core/src/types.ts",
);
const AIMOCK_TYPES_PATH = path.resolve(import.meta.dirname, "../../agui-types.ts");

/** The one canonical field this guard tracks across the non-event types. */
const FIELD = "subagentRunId";

const parse = (fileName: string, source: string) =>
  ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

const isExported = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

const propertyName = (name: ts.PropertyName | undefined): string | null =>
  name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null;

/**
 * The member names a zod schema initializer declares *itself*, at the top
 * level of its own object literal(s).
 *
 * The walk descends through the builder chain — `z.object({...})`,
 * `Base.extend({...})`, `z.object({...}).strict()` — but stops at every object
 * literal it reaches, collecting that literal's property names without
 * descending into their values. That boundary is what makes a nested
 * `subagentRunId` (say, inside a `z.object({ meta: z.object({ subagentRunId:
 * ... }) })`) invisible here, which is the point: a nested occurrence must not
 * mask the removal of the top-level one.
 *
 * "Itself" also excludes inherited members: `UserMessageSchema =
 * BaseMessageSchema.extend({ role: ... })` declares only `role`. Inheritance
 * is deliberately not resolved — the mirror list below covers the schemas that
 * *declare* the field, and resolving `.extend()` chains would drag in every
 * message subtype for a field they do not restate.
 */
function ownMemberNames(initializer: ts.Expression): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        const name = propertyName(property.name);
        if (name !== null) names.push(name);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(initializer);
  return names;
}

/**
 * Every exported top-level `const <Name> = <zod expression>` in the canonical
 * types module, mapped to the member names it declares itself.
 */
export function canonicalSchemaMembers(fileName: string, source: string): Map<string, string[]> {
  const schemas = new Map<string, string[]>();
  for (const statement of parse(fileName, source).statements) {
    if (!ts.isVariableStatement(statement) || !isExported(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      schemas.set(declaration.name.text, ownMemberNames(declaration.initializer));
    }
  }
  return schemas;
}

/** The canonical schemas that declare `field` as a member of their own object literal. */
export function canonicalSchemasDeclaring(
  fileName: string,
  source: string,
  field: string,
): string[] {
  return [...canonicalSchemaMembers(fileName, source)]
    .filter(([, members]) => members.includes(field))
    .map(([name]) => name)
    .sort();
}

/**
 * One top-level property signature of an aimock interface, read structurally.
 *
 * `optional` is true when the member can be absent *or* explicitly
 * `undefined`, so `x?: string` and `x: string | undefined` are the same fact.
 * `types` is the set of syntax kinds the (flattened) union admits, which is
 * what the widening rule below is expressed over. Nested type literals are not
 * searched: only the interface's own members count.
 */
export function aimockInterfaceMember(
  fileName: string,
  source: string,
  interfaceName: string,
  field: string,
): { optional: boolean; typeText: string; parts: ts.TypeNode[] } | null | undefined {
  for (const statement of parse(fileName, source).statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== interfaceName) continue;
    for (const member of statement.members) {
      if (!ts.isPropertySignature(member) || propertyName(member.name) !== field) continue;
      const type = member.type;
      const parts = type && ts.isUnionTypeNode(type) ? [...type.types] : type ? [type] : [];
      return {
        optional: member.questionToken !== undefined || parts.some(isUndefinedType),
        typeText: type ? type.getText() : "(no type)",
        parts,
      };
    }
    // Interface found, member absent.
    return null;
  }
  // Interface itself absent — a distinct fact from "declared without the field".
  return undefined;
}

const isUndefinedType = (node: ts.TypeNode) =>
  node.kind === ts.SyntaxKind.UndefinedKeyword ||
  (ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.UndefinedKeyword);

/**
 * The widening rule, stated once.
 *
 * Canonical `subagentRunId: z.string().optional()` parses to `string |
 * undefined`. An aimock mirror is CORRECT when it (a) exists, (b) can be
 * absent or `undefined`, and (c) admits a bare `string`. Anything that adds
 * further members to the union — `string | null`, `string | SomeBrand` — is an
 * ACCEPTABLE WIDENING: every canonical value still fits, so no fixture that
 * round-trips through the canonical schema can fail to type-check here.
 * NARROWING is drift: dropping optionality (a canonical value may be absent),
 * or replacing `string` with something stricter such as a literal union or a
 * branded alias (a canonical value may then not fit).
 *
 * Formatting, `readonly`, trailing punctuation, and member ordering are not
 * facts about the type and are invisible to this rule by construction.
 */
function mirrorProblem(member: { optional: boolean; typeText: string; parts: ts.TypeNode[] }) {
  if (!member.optional) {
    return `is required (\`${member.typeText}\`) but canonical declares it optional`;
  }
  const admitsString = member.parts.some((part) => part.kind === ts.SyntaxKind.StringKeyword);
  if (!admitsString) {
    return `has type \`${member.typeText}\`, which does not admit a bare \`string\``;
  }
  return null;
}

/**
 * Canonical schema -> the aimock interface that mirrors it.
 *
 * Aimock flattens the canonical message union into a single `AGUIMessage`
 * discriminated by `role`, so all four canonical message schemas that carry
 * `subagentRunId` map onto that one interface.
 *
 * This list is not trusted to be complete: the completeness test below asserts
 * it covers exactly the canonical schemas that declare the field, so a NEW
 * canonical schema carrying `subagentRunId` fails loudly here instead of going
 * silently uncompared.
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

/**
 * Truthiness for a CI-style environment flag.
 *
 * GitHub Actions sets `CI=true`, but other runners set `CI=1`, `CI=True`, or
 * `CI=yes`, and an exact `=== "true"` comparison hands all of those the local
 * escape hatch that is supposed to be unreachable in CI. Anything set and not
 * an explicit negation counts as CI.
 */
export function isTruthyEnvFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && !["0", "false", "no", "off"].includes(normalized);
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
  process.env.AIMOCK_ALLOW_MISSING_AGUI_CHECKOUT === "1" && !isTruthyEnvFlag(process.env.CI);

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
      expect(
        isTruthyEnvFlag(process.env.CI),
        "the missing-checkout opt-out must never apply in CI",
      ).toBe(false);
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

// Skipped whenever either source failed to read — which is the local opt-out
// case, and otherwise a case the availability gate above has ALREADY failed on,
// so the file still exits non-zero. The skip only suppresses a cascade of
// secondary failures that would all be restating the same missing checkout.
describe.skipIf(canonical.error !== null || aimock.error !== null)(
  "AG-UI non-event schema drift",
  () => {
    const schemas = canonicalSchemaMembers(CANONICAL_TYPES_PATH, canonicalSource);

    it("parses the canonical non-event schemas it compares", () => {
      // Positive control: a mirror silently going unparsed would make the drift
      // assertion below vacuously green.
      const unparsed = MIRRORS.map((m) => m.canonical).filter((name) => !schemas.has(name));
      expect(unparsed, `canonical schemas the parser did not find: ${unparsed.join(", ")}`).toEqual(
        [],
      );

      const interfaces = [...new Set(MIRRORS.map((m) => m.aimock))];
      const missing = interfaces.filter(
        (name) => aimockInterfaceMember(AIMOCK_TYPES_PATH, aimockSource, name, FIELD) === undefined,
      );
      expect(missing, `aimock interfaces the parser did not find: ${missing.join(", ")}`).toEqual(
        [],
      );
    });

    it("covers every canonical schema that declares subagentRunId", () => {
      // Completeness. MIRRORS is a hand-written map because the aimock side of
      // it cannot be derived (aimock flattens seven message schemas into one
      // interface), so the canonical side is derived instead and the two are
      // required to agree exactly. A new canonical schema carrying the field
      // fails here rather than being silently left uncompared, and a schema
      // that stops declaring it fails here rather than being compared against
      // nothing.
      const declared = canonicalSchemasDeclaring(CANONICAL_TYPES_PATH, canonicalSource, FIELD);
      const covered = [...new Set(MIRRORS.map((m) => m.canonical))].sort();
      expect(
        declared,
        `MIRRORS must cover exactly the canonical schemas declaring "${FIELD}". ` +
          `Canonical declares it on: ${declared.join(", ") || "(none)"}; ` +
          `MIRRORS covers: ${covered.join(", ")}. ` +
          `Add or remove a MIRRORS entry (and the matching aimock field) to match.`,
      ).toEqual(covered);
    });

    it("mirrors canonical subagentRunId onto the non-event interfaces", () => {
      const drifts: string[] = [];

      for (const { canonical: schemaName, aimock: interfaceName } of MIRRORS) {
        const members = schemas.get(schemaName);
        if (members === undefined) continue; // reported by the parse test above

        // The canonical side is ASSERTED, not used as a silent precondition. An
        // upstream rename or removal of `subagentRunId` is exactly the drift this
        // file exists to catch, so `continue`-ing past it here would report the
        // rename as "no drift".
        if (!members.includes(FIELD)) {
          drifts.push(
            `canonical ${schemaName} no longer declares "${FIELD}" — upstream renamed or ` +
              `removed it; update MIRRORS and aimock's ${interfaceName} to match`,
          );
          continue;
        }

        const member = aimockInterfaceMember(AIMOCK_TYPES_PATH, aimockSource, interfaceName, FIELD);
        if (member === undefined) continue; // reported by the parse test above
        if (member === null) {
          drifts.push(
            `${schemaName} declares optional "${FIELD}" but aimock's ${interfaceName} does not mirror it`,
          );
          continue;
        }
        const problem = mirrorProblem(member);
        if (problem !== null) {
          drifts.push(
            `${schemaName} declares optional "${FIELD}" but aimock's ${interfaceName}.${FIELD} ${problem}`,
          );
        }
      }

      expect(drifts, `Non-event subagent attribution drift:\n  ${drifts.join("\n  ")}`).toEqual([]);
    });
  },
);

// The guard is only as good as its readers, so the readers are tested directly
// on the shapes that defeat a regex/brace-counting implementation.
describe("non-event schema readers", () => {
  const member = (source: string, iface = "I") =>
    aimockInterfaceMember("types.ts", source, iface, FIELD);

  it("is not confused by a brace inside a comment", () => {
    const source = [
      "export const AlphaSchema = z.object({",
      "  // an opening brace { that a brace counter would follow",
      "  id: z.string(),",
      "});",
      "export const BetaSchema = z.object({",
      "  subagentRunId: z.string().optional(),",
      "});",
    ].join("\n");
    expect(canonicalSchemasDeclaring("types.ts", source, FIELD)).toEqual(["BetaSchema"]);
  });

  it("is not confused by a brace inside a string literal", () => {
    const source = [
      'export const AlphaSchema = z.object({ id: z.literal("{"), name: z.string() });',
      "export const BetaSchema = z.object({ subagentRunId: z.string().optional() });",
    ].join("\n");
    expect(canonicalSchemasDeclaring("types.ts", source, FIELD)).toEqual(["BetaSchema"]);
  });

  it("does not let a nested occurrence stand in for a top-level member", () => {
    const source =
      "export const AlphaSchema = z.object({ meta: z.object({ subagentRunId: z.string() }) });";
    expect(canonicalSchemaMembers("types.ts", source).get("AlphaSchema")).toEqual(["meta"]);
    expect(canonicalSchemasDeclaring("types.ts", source, FIELD)).toEqual([]);
  });

  it("reads members declared through an extend chain but not inherited ones", () => {
    const source = [
      "export const AlphaSchema = z.object({ subagentRunId: z.string().optional() });",
      "export const BetaSchema = AlphaSchema.extend({ role: z.literal('beta') });",
      "export const GammaSchema = z.object({ id: z.string() }).extend({ subagentRunId: z.string() });",
    ].join("\n");
    expect(canonicalSchemasDeclaring("types.ts", source, FIELD)).toEqual([
      "AlphaSchema",
      "GammaSchema",
    ]);
  });

  it("skips unexported and non-schema declarations", () => {
    const source = [
      "const HiddenSchema = z.object({ subagentRunId: z.string() });",
      "export const VisibleSchema = z.object({ subagentRunId: z.string() });",
    ].join("\n");
    expect(canonicalSchemasDeclaring("types.ts", source, FIELD)).toEqual(["VisibleSchema"]);
  });

  it("distinguishes a missing interface from a missing member", () => {
    expect(member("export interface Other { subagentRunId?: string }")).toBeUndefined();
    expect(member("export interface I { id: string }")).toBeNull();
  });

  it("reads optionality from the question token", () => {
    expect(member("export interface I { subagentRunId?: string }")).toMatchObject({
      optional: true,
    });
    expect(member("export interface I { subagentRunId: string }")).toMatchObject({
      optional: false,
    });
  });

  it("treats an explicit `| undefined` union as optional", () => {
    expect(member("export interface I { subagentRunId: string | undefined }")).toMatchObject({
      optional: true,
    });
  });

  it("ignores a nested type literal's members", () => {
    expect(member("export interface I { nested: { subagentRunId?: string } }")).toBeNull();
  });

  it("is unaffected by readonly, formatting, and missing semicolons", () => {
    const source = [
      "export interface I {",
      "  readonly",
      "  subagentRunId?:",
      "    string",
      "}",
    ].join("\n");
    expect(mirrorProblem(member(source)!)).toBeNull();
  });
});

describe("non-event widening rule", () => {
  const problemFor = (declaration: string) => {
    const parsed = aimockInterfaceMember(
      "types.ts",
      `export interface I { ${declaration} }`,
      "I",
      FIELD,
    );
    if (parsed === null || parsed === undefined) throw new Error("member not parsed");
    return mirrorProblem(parsed);
  };

  it.each([
    "subagentRunId?: string;",
    "subagentRunId?: string | null;",
    "subagentRunId: string | undefined;",
    "subagentRunId?: string | number;",
  ])("accepts the widening %s", (declaration) => {
    expect(problemFor(declaration)).toBeNull();
  });

  it.each([
    ["subagentRunId: string;", "is required"],
    ['subagentRunId?: "a" | "b";', "does not admit"],
    ["subagentRunId?: number;", "does not admit"],
  ])("rejects the narrowing %s", (declaration, fragment) => {
    expect(problemFor(declaration)).toContain(fragment);
  });
});
