import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// ---------------------------------------------------------------------------
// Public-surface guard: every type declared in src/agui-types.ts must be
// re-exported from both barrels that front it — the package root (src/index.ts)
// and the "./agui" subpath entry (src/agui-stub.ts). A type that exists but is
// unreachable from an entry point cannot be named by a consumer, and the
// omission is invisible to the compiler, so it needs an explicit test.
//
// The property under test is *reachability under the declared name*, so the
// files are read with the TypeScript parser rather than with regexes. A regex
// scan of TypeScript fails open in exactly the ways this guard must not: a
// comma inside a comment corrupts a naively split export block, and `X as Y`
// looks like an export of `X` while actually making `X` unreachable. The
// parser sees comments as trivia and models a rename as a distinct
// `propertyName`/`name` pair, so both cases are handled by construction.
//
// A runtime import cannot be used here: these are type-only exports, erased
// before any module is evaluated, so there is nothing to inspect at runtime.
// Parsing the module graph is the closest sound check available at this cost.
// ---------------------------------------------------------------------------

const TYPES_MODULE = "./agui-types.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const parse = (fileName: string, source: string) =>
  ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

const isExported = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** Names of the exported `type` / `interface` declarations in a source file. */
function declaredTypeNames(fileName: string, source: string): string[] {
  const names: string[] = [];
  for (const statement of parse(fileName, source).statements) {
    if (!ts.isTypeAliasDeclaration(statement) && !ts.isInterfaceDeclaration(statement)) continue;
    if (!isExported(statement)) continue;
    names.push(statement.name.text);
  }
  return names;
}

/**
 * Names of `./agui-types.js` that a barrel makes reachable *under their own
 * name*. A renamed re-export (`export type { X as Y }`) publishes `Y` and
 * leaves `X` unreachable, so it contributes nothing to this set: neither `X`
 * (not reachable) nor `Y` (not a name declared in agui-types.ts).
 * A star re-export makes every name reachable, so it short-circuits to `true`.
 */
function reExportedFromTypes(fileName: string, source: string): Set<string> | true {
  const names = new Set<string>();
  for (const statement of parse(fileName, source).statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier) || specifier.text !== TYPES_MODULE) continue;
    // `export * from "./agui-types.js"` re-exports everything under its own name.
    if (!statement.exportClause) return true;
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      const exportedAs = element.name.text;
      const local = element.propertyName?.text ?? exportedAs;
      if (local === exportedAs) names.add(exportedAs);
    }
  }
  return names;
}

const typeNames = declaredTypeNames("agui-types.ts", read("../agui-types.ts"));

describe("AG-UI type barrel exports", () => {
  it("declares the subagent types it is meant to publish", () => {
    expect(typeNames).toEqual(
      expect.arrayContaining([
        "AGUISubagentStartedEvent",
        "AGUISubagentFinishedEvent",
        "AGUISubagentErrorEvent",
        "AGUISubagentFinishedOutcome",
      ]),
    );
  });

  it.each([
    ["src/index.ts", "../index.ts"],
    ["src/agui-stub.ts", "../agui-stub.ts"],
  ])("re-exports every agui-types.ts type from %s", (label, rel) => {
    const exported = reExportedFromTypes(label, read(rel));
    if (exported === true) return;
    // Positive control: a total parse failure would yield an empty set and let
    // every assertion below pass vacuously.
    expect(exported.size).toBeGreaterThan(0);
    const missing = typeNames.filter((name) => !exported.has(name));
    expect(missing).toEqual([]);
  });
});

// The guard is only as good as its reader, so the reader is tested directly on
// the two shapes that defeat a regex-based implementation.
describe("barrel export reader", () => {
  it("ignores commas inside comments in an export block", () => {
    const source = [
      "export type {",
      "  AGUIAlpha,",
      "  // a comment, with a comma, in it",
      "  AGUIBeta,",
      '} from "./agui-types.js";',
    ].join("\n");
    expect(reExportedFromTypes("barrel.ts", source)).toEqual(new Set(["AGUIAlpha", "AGUIBeta"]));
  });

  it("does not treat a renamed re-export as reachability of the original name", () => {
    const source = 'export type { AGUIAlpha as AGUIRenamed, AGUIBeta } from "./agui-types.js";';
    expect(reExportedFromTypes("barrel.ts", source)).toEqual(new Set(["AGUIBeta"]));
  });

  it("ignores re-exports from other modules", () => {
    const source = 'export type { AGUIAlpha } from "./somewhere-else.js";';
    expect(reExportedFromTypes("barrel.ts", source)).toEqual(new Set());
  });

  it("treats a star re-export as publishing every name", () => {
    expect(reExportedFromTypes("barrel.ts", 'export * from "./agui-types.js";')).toBe(true);
  });

  it("reads exported type and interface declarations, and skips unexported ones", () => {
    const source = [
      "export type AGUIAlpha = string;",
      "export interface AGUIBeta { a: number }",
      "interface AGUIPrivate { b: number }",
      "type AGUIAlsoPrivate = number;",
    ].join("\n");
    expect(declaredTypeNames("types.ts", source)).toEqual(["AGUIAlpha", "AGUIBeta"]);
  });
});
