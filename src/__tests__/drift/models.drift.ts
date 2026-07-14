/**
 * Model deprecation checks — verify that models referenced in aimock's
 * tests, docs, and examples still exist at each provider.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { listOpenAIModels, listAnthropicModels, listGeminiModels } from "./providers.js";

// ---------------------------------------------------------------------------
// Scrape referenced models from the codebase
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

export function scrapeModels(pattern: RegExp, files: string[]): string[] {
  const models = new Set<string>();
  for (const file of files) {
    const filePath = path.join(PROJECT_ROOT, file);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf-8");
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      models.add(match[1]);
    }
  }
  return [...models];
}

export const sourceFiles = [
  "src/__tests__/api-conformance.test.ts",
  "src/__tests__/ws-api-conformance.test.ts",
  "README.md",
  "fixtures/example-greeting.json",
  "fixtures/example-multi-turn.json",
  "fixtures/example-tool-call.json",
];

// Regex used to scrape Gemini model ids from the source files above. Greedy
// on purpose so we catch versioned/dated ids (e.g. gemini-2.5-flash), but that
// greed also grabs any `gemini-*` token appearing in prose — see the stable
// filter below for what gets excluded.
export const GEMINI_MODEL_PATTERN = /\b(gemini-(?:[\w.-]+))\b/g;

// aimock exposes "provider modes" — internal names that route to a real
// upstream API but are NOT themselves model ids exposed by that provider. The
// README documents them (e.g. `gemini-interactions` reuses the Gemini upstream
// key), so the greedy scraper above grabs them as if they were Gemini models.
// They will never appear in Google's model list, so checking them for drift is
// a guaranteed false positive. Exclude them explicitly.
const AIMOCK_GEMINI_PROVIDER_MODES = new Set(["gemini-interactions"]);

// Narrow a raw scrape of `gemini-*` tokens down to real, checkable model ids by
// dropping (a) experimental/live/preview ids, (b) markdown anchor-link
// fragments, and (c) aimock provider-mode names that are documentation prose,
// not provider model ids. Exported so the regression suite can exercise the
// exact filtering the drift check relies on.
export function filterStableGeminiModels(referenced: string[]): string[] {
  return referenced.filter(
    (m) =>
      !m.includes("-exp") &&
      !m.includes("-live") &&
      !m.includes("bidigeneratecontent") &&
      !AIMOCK_GEMINI_PROVIDER_MODES.has(m),
  );
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI model availability", () => {
  it("models used in aimock tests are still available", async () => {
    const models = await listOpenAIModels(process.env.OPENAI_API_KEY!);
    const referenced = scrapeModels(/\b(gpt-4o(?:-mini)?|gpt-4|gpt-3\.5-turbo)\b/g, sourceFiles);

    if (referenced.length === 0) return; // no models found to check

    for (const m of referenced) {
      // OpenAI model list may include versioned variants — check prefix match
      const found = models.some((available) => available === m || available.startsWith(`${m}-`));
      expect(found, `Model ${m} no longer available at OpenAI`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic model availability", () => {
  it("models used in aimock tests are still available", async () => {
    const models = await listAnthropicModels(process.env.ANTHROPIC_API_KEY!);
    const referenced = scrapeModels(
      /\b(claude-3(?:\.\d+)?-(?:opus|sonnet|haiku)(?:-\d{8})?)\b/g,
      sourceFiles,
    );

    if (referenced.length === 0) return;

    for (const m of referenced) {
      const found = models.some((available) => available === m || available.startsWith(m));
      expect(found, `Model ${m} no longer available at Anthropic`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.GOOGLE_API_KEY)("Gemini model availability", () => {
  it("models used in aimock tests are still available", async () => {
    const models = await listGeminiModels(process.env.GOOGLE_API_KEY!);
    const referenced = scrapeModels(GEMINI_MODEL_PATTERN, sourceFiles);

    if (referenced.length === 0) return;

    // Drop experimental/live ids, markdown anchor fragments, and aimock
    // provider-mode names (see filterStableGeminiModels).
    const stable = filterStableGeminiModels(referenced);

    for (const m of stable) {
      const found = models.some((available) => available === m || available.startsWith(m));
      expect(found, `Model ${m} no longer available at Gemini`).toBe(true);
    }
  });
});
