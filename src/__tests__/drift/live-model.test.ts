/**
 * Unit tests for the SHARED live-model discovery + infra-skip helpers.
 *
 * These generalize the two already-merged self-healing patterns so the R1-R5
 * live-leg retrofits reuse ONE util instead of each inlining a divergent copy:
 *   - Cohere dynamic model discovery (#325): resolve a live, non-deprecated
 *     model id from the provider's own `/models` listing rather than hardcoding
 *     one that the provider later retires (the `command-r-plus` 404 quarantine).
 *   - fal infra-skip (#332): classify an auth/credit/rate-limit/5xx provider
 *     condition as an HONEST SKIP so a transient provider-side outage never
 *     quarantines the drift baseline (exit-5 mass-quarantine).
 *
 * Fixture-based ONLY — no live network. The listing is stubbed.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  isInfraSkip,
  isModelNotFound,
  selectLiveModel,
  resolveLiveModel,
  __resetResolveLiveModelCache,
  InfraError,
  type LiveModelEntry,
} from "./providers.js";

describe("isInfraSkip", () => {
  it("classifies auth/credit/rate-limit/5xx as an honest skip", () => {
    for (const s of [401, 402, 403, 429, 500, 502, 503, 529]) {
      expect(isInfraSkip(s)).toBe(true);
    }
  });

  it("does NOT skip a success or a genuine envelope/probe error", () => {
    for (const s of [200, 201, 400, 404, 422]) {
      expect(isInfraSkip(s)).toBe(false);
    }
  });
});

describe("isModelNotFound", () => {
  it("treats a bare 404 as model-not-found (retired model id)", () => {
    expect(isModelNotFound(404)).toBe(true);
  });

  it("treats a 400 whose body names a model-not-found condition as such", () => {
    expect(isModelNotFound(400, '{"error":{"code":"model_not_found"}}')).toBe(true);
    expect(isModelNotFound(400, "The model `gpt-foo` does not exist")).toBe(true);
    expect(isModelNotFound(400, "unknown model: claude-retired")).toBe(true);
  });

  it("does NOT treat an unrelated 400 or a success as model-not-found", () => {
    expect(isModelNotFound(400, "invalid_request_error: missing messages")).toBe(false);
    expect(isModelNotFound(400)).toBe(false);
    expect(isModelNotFound(200)).toBe(false);
  });
});

describe("selectLiveModel", () => {
  it("never selects a deprecated model", () => {
    const models: LiveModelEntry[] = [
      { id: "old-model", deprecated: true },
      { id: "fresh-model", deprecated: false },
    ];
    const chosen = selectLiveModel(models);
    expect(chosen).not.toBe("old-model");
    expect(chosen).toBe("fresh-model");
  });

  it("prefers an id from the preferred list when present and live", () => {
    const models: LiveModelEntry[] = [{ id: "experimental" }, { id: "stable-default" }];
    expect(selectLiveModel(models, ["missing", "stable-default"])).toBe("stable-default");
  });

  it("never prefers a deprecated id even if it is in the preferred list", () => {
    const models: LiveModelEntry[] = [
      { id: "stable-default", deprecated: true },
      { id: "next-best" },
    ];
    expect(selectLiveModel(models, ["stable-default"])).toBe("next-best");
  });

  it("falls back to the first live model when no preferred id is present", () => {
    const models: LiveModelEntry[] = [
      { id: "retired", deprecated: true },
      { id: "first-live" },
      { id: "second-live" },
    ];
    expect(selectLiveModel(models, ["not-here"])).toBe("first-live");
  });

  it("returns null when no usable live model exists", () => {
    expect(selectLiveModel([{ id: "retired", deprecated: true }])).toBeNull();
    expect(selectLiveModel([])).toBeNull();
    expect(selectLiveModel([{ id: "" }])).toBeNull();
  });
});

describe("resolveLiveModel", () => {
  beforeEach(() => __resetResolveLiveModelCache());

  it("resolves a live, non-deprecated id from a stubbed listing", async () => {
    const resolved = await resolveLiveModel("p1", async () => ({
      status: 200,
      models: [{ id: "retired", deprecated: true }, { id: "live-one" }],
    }));
    expect(resolved).toEqual({ model: "live-one" });
  });

  it("honest-skips (infra) when the listing hits an auth/credit/rate/5xx status", async () => {
    const resolved = await resolveLiveModel("p2", async () => ({ status: 401, models: [] }));
    expect(resolved).toEqual({ infra: 401 });
  });

  it("reports unavailable (fail-loud) on a non-infra listing error", async () => {
    const resolved = await resolveLiveModel("p3", async () => ({ status: 404, models: [] }));
    expect(resolved).toEqual({ unavailable: true });
  });

  it("reports unavailable when the listing exposes no usable live model", async () => {
    const resolved = await resolveLiveModel("p4", async () => ({
      status: 200,
      models: [{ id: "retired", deprecated: true }],
    }));
    expect(resolved).toEqual({ unavailable: true });
  });

  it("maps a thrown InfraError to an honest infra skip", async () => {
    const resolved = await resolveLiveModel("p5", async () => {
      throw new InfraError("INFRA_ERROR: listing down", 503);
    });
    expect(resolved).toEqual({ infra: 503 });
  });

  it("memoizes per key: the listing is fetched exactly once", async () => {
    let calls = 0;
    const fetchListing = async () => {
      calls++;
      return { status: 200, models: [{ id: "live-one" }] as LiveModelEntry[] };
    };
    const a = await resolveLiveModel("p6", fetchListing);
    const b = await resolveLiveModel("p6", fetchListing);
    expect(a).toEqual({ model: "live-one" });
    expect(b).toEqual({ model: "live-one" });
    expect(calls).toBe(1);
  });

  it("resets the memo cache so a fresh listing is fetched again", async () => {
    let calls = 0;
    const fetchListing = async () => {
      calls++;
      return { status: 200, models: [{ id: "live-one" }] as LiveModelEntry[] };
    };
    await resolveLiveModel("p7", fetchListing);
    __resetResolveLiveModelCache();
    await resolveLiveModel("p7", fetchListing);
    expect(calls).toBe(2);
  });
});
