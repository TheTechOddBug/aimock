/**
 * Zero-reference cross-check for the C4 deprecation detector (`models.drift.ts`).
 *
 * A model family that a healthy live `/models` listing no longer contains is
 * only SAFE to auto-propose for removal from the frozen registry
 * (`model-registry.ts`) if aimock's own source no longer references it — a
 * still-referenced family must route to a human instead (§4.4), never be
 * silently classified away. This module owns the mechanical, zero-LLM scan
 * that answers that one question: does the family string still appear,
 * as a real token (not a substring artifact of a longer sibling id), anywhere
 * in aimock's own source tree?
 *
 * Deliberately co-located here (NOT in `helpers.ts` — Correction S1): this is
 * drift-detector-specific I/O, not a shared cross-provider live-discovery
 * utility like `providers.ts`'s `resolveLiveModel`/`isInfraSkip`.
 *
 * Scanned root: `src/` EXCLUDING `src/__tests__/drift/` itself. The drift
 * directory is the CLASSIFICATION layer (the registry seeds, this detector,
 * its tests) — every family literal trivially appears there by definition, so
 * including it would make every family look "still referenced" and defeat the
 * entire check. Everywhere else under `src/` (server.ts's `DEFAULT_MODELS`,
 * provider builder files, non-drift test fixtures/conformance suites) is a
 * legitimate signal of real usage.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** `src/` — two levels up from this file (`src/__tests__/drift/`). */
const SRC_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Directory (relative to `SRC_ROOT`) excluded from the ref-scan — see module doc. */
const EXCLUDED_REL_DIR = join("__tests__", "drift");

function isExcludedDir(name: string, relPath: string): boolean {
  if (name === "node_modules" || name === "dist") return true;
  return relPath === EXCLUDED_REL_DIR || relPath.startsWith(EXCLUDED_REL_DIR + "/");
}

/** Recursively collect every `.ts`/`.tsx` file under `root`, skipping excluded dirs. */
function collectSourceFiles(root: string): string[] {
  const files: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const rel = full.slice(root.length).replace(/^[/\\]+/, "");
        if (isExcludedDir(entry.name, rel)) continue;
        stack.push(full);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        files.push(full);
      }
    }
  }
  return files;
}

/** Escape a string for safe interpolation into a `RegExp` literal. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Memoized concatenation of every scanned file's source text (computed once, lazily). */
let cachedSourceText: string | null = null;

function allSourceText(): string {
  if (cachedSourceText === null) {
    cachedSourceText = collectSourceFiles(SRC_ROOT)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
  }
  return cachedSourceText;
}

/** Test-only: drop the memoized source cache (the source tree does not change mid-run). */
export function __resetSourceScanCache(): void {
  cachedSourceText = null;
}

/**
 * True when `family` still appears as a real token (bounded by anything other
 * than a word character, `.`, or `-`) anywhere in aimock's own source outside
 * `src/__tests__/drift/`. Boundary-aware so a shorter family that is a strict
 * prefix of another live id's family (e.g. `gpt-4` vs. `gpt-4o` / `gpt-4-turbo`)
 * is never mistaken for a hit — a naive substring scan would otherwise call
 * `gpt-4` "referenced" merely because `gpt-4o` appears in source, silently
 * blocking a legitimate removal proposal forever.
 *
 * Takes an unused second parameter slot deliberately absent: the scan is not
 * provider-scoped (a family string is checked against the whole non-drift
 * source tree), but its call signature is still assignable to the detector's
 * injectable `(family: string, provider: Provider) => boolean` shape — a
 * function with fewer parameters is always assignable there.
 */
export function isFamilyStillReferenced(family: string): boolean {
  const pattern = new RegExp(`(?<![\\w.-])${escapeRegExp(family)}(?![\\w.-])`);
  return pattern.test(allSourceText());
}

// ---------------------------------------------------------------------------
// Forward-looking families — distinct concern from "still referenced" above.
// ---------------------------------------------------------------------------

type Provider = "openai" | "anthropic" | "gemini";

/**
 * Model families deliberately classified INCLUDE ahead of general
 * availability (see `model-registry.ts`'s inline "forward-looking" comment on
 * `claude-fable-5`). A forward-looking family is, BY CONSTRUCTION, absent
 * from every live `/models` listing until it launches — that is
 * indistinguishable, to a naive `classified − live` diff, from a genuine
 * retirement. It is ALSO indistinguishable via `isFamilyStillReferenced`:
 * aimock legitimately has no builder/fixture reference to a family it has not
 * built yet, so that scan reports zero-reference too, same as a truly
 * retired family would. Without this allowlist, a forward-looking family
 * would be mechanically proposed for removal (or routed to a needs-human
 * note) on EVERY daily drift-sync run — pure noise a human has to
 * reject/dismiss every day, forever, until the family finally goes GA.
 *
 * A family listed here is excluded from `detectDeprecatedFamiliesForSync`'s
 * `missing` candidate set entirely (see `scripts/drift-sync.ts`) — no removal
 * proposal, no needs-human note, nothing. Reversible: delete the entry the
 * same day the family actually appears in a live listing (at that point it is
 * a real, launched family like any other, and ordinary deprecation detection
 * applies to it going forward).
 */
export const FORWARD_LOOKING_FAMILIES: Record<Provider, ReadonlySet<string>> = {
  openai: new Set(),
  anthropic: new Set(["claude-fable-5"]),
  gemini: new Set(),
};

/** True when `family` is a known forward-looking (not-yet-launched) INCLUDE entry. */
export function isForwardLookingFamily(family: string, provider: Provider): boolean {
  return FORWARD_LOOKING_FAMILIES[provider].has(family);
}
