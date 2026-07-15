/**
 * Unit test for the per-provider model-family registry shape.
 *
 * This is the minimal shape/invariant probe for the registry itself. The full
 * builder/fixture cross-check (every referenced model id resolves into the
 * registry) is B4.3's job and lives in its own extended suite — this test only
 * proves the registry is well-formed:
 *   - seeded families are normalization-consistent (membership works),
 *   - the provider-mode allowlist carries `gemini-interactions`,
 *   - no family appears in BOTH include and exclude for any provider.
 */
import { describe, it, expect } from "vitest";
import { normalizeModelFamily } from "./model-family.js";
import { includeFamilies, excludeFamilies, NON_MODEL_TOKENS } from "./model-registry.js";

describe("model-registry", () => {
  it("include contains the normalized family of a mocked model id", () => {
    expect(includeFamilies.gemini.has(normalizeModelFamily("gemini-2.5-flash", "gemini"))).toBe(
      true,
    );
  });

  it("allowlists the gemini-interactions provider-mode token", () => {
    expect(NON_MODEL_TOKENS.has("gemini-interactions")).toBe(true);
  });

  it("no family appears in both include and exclude for any provider", () => {
    for (const provider of ["openai", "anthropic", "gemini"] as const) {
      const inc = includeFamilies[provider];
      const exc = excludeFamilies[provider];
      const overlap = [...inc].filter((f) => exc.has(f));
      expect(
        overlap,
        `provider ${provider} has families on both lists: ${overlap.join(", ")}`,
      ).toEqual([]);
    }
  });

  it("seeds are idempotent under normalization (already family keys)", () => {
    for (const provider of ["openai", "anthropic", "gemini"] as const) {
      for (const family of includeFamilies[provider]) {
        expect(normalizeModelFamily(family, provider)).toBe(family);
      }
      for (const family of excludeFamilies[provider]) {
        expect(normalizeModelFamily(family, provider)).toBe(family);
      }
    }
  });
});
