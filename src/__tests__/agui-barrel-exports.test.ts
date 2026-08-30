import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Public-surface guard: every type declared in src/agui-types.ts must be
// re-exported from both barrels that front it — the package root (src/index.ts)
// and the "./agui" subpath entry (src/agui-stub.ts). A type that exists but is
// unreachable from an entry point cannot be named by a consumer, and the
// omission is invisible to the compiler, so it needs an explicit test.
// ---------------------------------------------------------------------------

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Names of the `export type` / `export interface` declarations in a source file. */
function declaredTypeNames(source: string): string[] {
  return [...source.matchAll(/^export (?:type|interface) ([A-Za-z0-9_]+)/gm)].map((m) => m[1]);
}

/** Names re-exported from "./agui-types.js" by a barrel file. */
function reExportedFromTypes(source: string): Set<string> {
  const names = new Set<string>();
  for (const block of source.matchAll(/export type \{([^}]*)\} from "\.\/agui-types\.js";/g)) {
    for (const raw of block[1].split(",")) {
      const name = raw
        .replace(/\/\/[^\n]*/g, "")
        .trim()
        .split(/\s+as\s+/)[0]
        .trim();
      if (name) names.add(name);
    }
  }
  return names;
}

const typeNames = declaredTypeNames(read("../agui-types.ts"));

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
  ])("re-exports every agui-types.ts type from %s", (_label, rel) => {
    const exported = reExportedFromTypes(read(rel));
    expect(exported.size).toBeGreaterThan(0);
    const missing = typeNames.filter((name) => !exported.has(name));
    expect(missing).toEqual([]);
  });
});
