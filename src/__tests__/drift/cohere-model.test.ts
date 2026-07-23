/**
 * Unit tests for the Cohere live-leg model selection + infra classification.
 *
 * These exercise the exact logic that fixes the drift-live-pr quarantine: the
 * live leg was hardcoded to `command-r-plus`, which Cohere retired 2026-04-04,
 * so the real `/v2/chat` call returned 404 (model not found) and quarantined
 * as exit 5. The selector must skip deprecated models and pick a live one.
 */

import { describe, it, expect } from "vitest";
import { isInfraStatus, selectCohereChatModel, type CohereModelEntry } from "./cohere-model.js";

describe("selectCohereChatModel", () => {
  it("never selects a deprecated model (the command-r-plus 404 regression)", () => {
    const models: CohereModelEntry[] = [
      { name: "command-r-plus", is_deprecated: true, endpoints: ["chat"] },
      { name: "command-a-03-2025", is_deprecated: false, endpoints: ["chat"] },
    ];
    const chosen = selectCohereChatModel(models);
    expect(chosen).not.toBe("command-r-plus");
    expect(chosen).toBe("command-a-03-2025");
  });

  it("prefers a stable default when present", () => {
    const models: CohereModelEntry[] = [
      { name: "some-experimental-model", is_deprecated: false, endpoints: ["chat"] },
      { name: "command-a-03-2025", is_deprecated: false, endpoints: ["chat"] },
    ];
    expect(selectCohereChatModel(models)).toBe("command-a-03-2025");
  });

  it("falls back to the first non-deprecated model when no preferred present", () => {
    const models: CohereModelEntry[] = [
      { name: "command-r-plus", is_deprecated: true, endpoints: ["chat"] },
      { name: "north-mini-code-1-0", is_deprecated: false, endpoints: ["chat"] },
    ];
    expect(selectCohereChatModel(models)).toBe("north-mini-code-1-0");
  });

  it("returns null when no usable chat model exists", () => {
    const models: CohereModelEntry[] = [
      { name: "command-r-plus", is_deprecated: true, endpoints: ["chat"] },
    ];
    expect(selectCohereChatModel(models)).toBeNull();
    expect(selectCohereChatModel([])).toBeNull();
  });
});

describe("isInfraStatus", () => {
  it("classifies auth/credit/rate-limit/5xx as infra (honest-skip conditions)", () => {
    for (const s of [401, 402, 403, 429, 500, 502, 503, 529]) {
      expect(isInfraStatus(s)).toBe(true);
    }
  });

  it("does NOT classify success or a genuine drift/probe error as infra", () => {
    for (const s of [200, 400, 404, 422]) {
      expect(isInfraStatus(s)).toBe(false);
    }
  });
});
