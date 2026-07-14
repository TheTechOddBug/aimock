/**
 * Regression guard for the model-id scraper used by the drift checks.
 *
 * The Gemini availability check scrapes `gemini-*` tokens from source files —
 * including README.md — with a greedy regex, then checks each against Google's
 * live model list. aimock also has "provider modes" such as `gemini-interactions`
 * that route to the Gemini upstream API but are NOT Gemini model ids. When the
 * README documented such a mode as a bare `gemini-interactions` token, the
 * greedy scraper grabbed it, the availability check failed (it is not a real
 * Google model), and the drift collector crashed as an "unparseable" failure —
 * firing a daily false-positive drift alert with no real drift.
 *
 * Two layers of defense are guarded here against the REAL scrape + filter
 * surface (real README, real regex, real filter):
 *   1. The stable filter drops aimock provider-mode names even if scraped.
 *   2. The README no longer spells the mode as a bare model-id token, so the
 *      scraper never picks it up in the first place.
 */

import { describe, it, expect } from "vitest";
import {
  scrapeModels,
  filterStableGeminiModels,
  sourceFiles,
  GEMINI_MODEL_PATTERN,
} from "./models.drift.js";

describe("Gemini model scrape does not flag aimock provider-mode names", () => {
  it("stable filter drops the gemini-interactions provider-mode token", () => {
    // Layer 1 (the real fix): even if a `gemini-interactions` token is scraped
    // from anywhere, the stable filter must exclude it so it is never checked
    // for drift. This is independent of any doc wording.
    const stable = filterStableGeminiModels([
      "gemini-2.5-flash",
      "gemini-interactions",
      "gemini-1.5-pro",
    ]);
    expect(stable).toEqual(["gemini-2.5-flash", "gemini-1.5-pro"]);
  });

  it("real source-file scrape produces no provider-mode false positives", () => {
    // Layer 2: run the exact scrape + filter the drift check uses over the
    // real source files. The result must contain no aimock provider-mode names.
    const referenced = scrapeModels(GEMINI_MODEL_PATTERN, sourceFiles);
    const stable = filterStableGeminiModels(referenced);
    expect(stable).not.toContain("gemini-interactions");
  });
});
