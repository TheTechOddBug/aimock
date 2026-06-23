import { describe, it, expect, vi, afterEach } from "vitest";
import { matchFixtureDiagnostic, _resetTurnIndexRelaxWarnings } from "../router.js";
import { LLMock } from "../llmock.js";
import type { ChatCompletionRequest, Fixture } from "../types.js";

// ===========================================================================
// turnIndex relaxation: detection + warn + opt-out (AIMOCK_STRICT_TURN_INDEX).
// The replay matcher relaxed turnIndex from a hard reject gate to a non-fatal
// disambiguator (PR #276). These tests cover the strictly-additive
// detect/warn/opt-out package layered on top of that change.
// ===========================================================================

function makeReq(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

function makeFixture(
  match: Fixture["match"],
  response: Fixture["response"] = { content: "ok" },
): Fixture {
  return { match, response };
}

// A fake logger whose warn() can be spied on. Structural — matches the subset
// of Logger the router uses.
function fakeLogger() {
  return { warn: vi.fn() };
}

// A divergent request: one assistant bubble already present (assistantCount 1),
// but the only content-matching fixture is scripted at turnIndex 0 (defined and
// != assistantCount). Under relaxed replay it is SERVED; the strict gate WOULD
// HAVE rejected it.
function divergentRequest(): ChatCompletionRequest {
  return makeReq({
    messages: [
      { role: "user", content: "diverge" },
      { role: "assistant", content: "first turn" },
      { role: "user", content: "diverge" },
    ],
  });
}

afterEach(() => {
  _resetTurnIndexRelaxWarnings();
  delete process.env.AIMOCK_STRICT_TURN_INDEX;
  vi.restoreAllMocks();
});

describe("turnIndex relaxation: divergence detect + warn", () => {
  it("serves the divergent fixture, warns exactly once, sets turnIndexRelaxed=true", () => {
    const logger = fakeLogger();
    const fixtures = [makeFixture({ userMessage: "diverge", turnIndex: 0 }, { content: "served" })];
    const diag = matchFixtureDiagnostic(fixtures, divergentRequest(), undefined, undefined, {
      logger,
    });
    // (a) served
    expect(diag.fixture).not.toBeNull();
    expect(diag.fixture?.response).toEqual({ content: "served" });
    // (b) warn fires exactly once
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain("turnIndex relaxed");
    expect(String(logger.warn.mock.calls[0][0])).toContain("AIMOCK_STRICT_TURN_INDEX=1");
    // (c) diagnostic field
    expect(diag.turnIndexRelaxed).toBe(true);
    expect(diag.matchedBy).toBe("content");
  });
});

describe("turnIndex relaxation: AIMOCK_STRICT_TURN_INDEX opt-out", () => {
  it("with the env var set, the divergent fixture is NOT served (strict gate restored)", () => {
    process.env.AIMOCK_STRICT_TURN_INDEX = "1";
    const logger = fakeLogger();
    const fixtures = [makeFixture({ userMessage: "diverge", turnIndex: 0 }, { content: "served" })];
    const diag = matchFixtureDiagnostic(fixtures, divergentRequest(), undefined, undefined, {
      logger,
    });
    expect(diag.fixture).toBeNull();
    // No relaxed serve → no warn.
    expect(logger.warn).not.toHaveBeenCalled();
    expect(diag.turnIndexRelaxed).toBeFalsy();
  });
});

describe("turnIndex relaxation: warn throttle", () => {
  it("multiple divergent requests for the same fixture warn exactly once", () => {
    const logger = fakeLogger();
    const fixtures = [makeFixture({ userMessage: "diverge", turnIndex: 0 }, { content: "served" })];
    matchFixtureDiagnostic(fixtures, divergentRequest(), undefined, undefined, { logger });
    matchFixtureDiagnostic(fixtures, divergentRequest(), undefined, undefined, { logger });
    matchFixtureDiagnostic(fixtures, divergentRequest(), undefined, undefined, { logger });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("turnIndex relaxation: throttle keyed by fixture identity (no collision)", () => {
  it("two DISTINCT divergent fixtures whose match serializes identically still each warn", () => {
    // Both fixtures carry a `predicate` (dropped by JSON.stringify) plus the
    // SAME serializable fields, so `JSON.stringify(match)` is byte-identical for
    // the two — yet they are different fixture objects mapping to different
    // responses. A throttle keyed on the serialized match collides and
    // suppresses the SECOND warn; a throttle keyed on fixture IDENTITY warns for
    // BOTH. They are served in separate calls so each is the selected fixture.
    const logger = fakeLogger();
    const predicate = () => true;
    const fixtureA = makeFixture(
      { userMessage: "diverge", turnIndex: 0, predicate },
      { content: "served-A" },
    );
    const fixtureB = makeFixture(
      { userMessage: "diverge", turnIndex: 0, predicate },
      { content: "served-B" },
    );
    // Sanity: the two matches serialize identically (the collision precondition).
    expect(JSON.stringify(fixtureA.match)).toBe(JSON.stringify(fixtureB.match));

    const diagA = matchFixtureDiagnostic([fixtureA], divergentRequest(), undefined, undefined, {
      logger,
    });
    const diagB = matchFixtureDiagnostic([fixtureB], divergentRequest(), undefined, undefined, {
      logger,
    });

    expect(diagA.fixture?.response).toEqual({ content: "served-A" });
    expect(diagB.fixture?.response).toEqual({ content: "served-B" });
    expect(diagA.turnIndexRelaxed).toBe(true);
    expect(diagB.turnIndexRelaxed).toBe(true);
    // Identity-keyed throttle → both distinct fixtures warn (2 total). A
    // serialized-match key collides and suppresses the second → only 1.
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("the SAME fixture object served twice still warns exactly once (identity throttle)", () => {
    const logger = fakeLogger();
    const fixture = makeFixture({ userMessage: "diverge", turnIndex: 0 }, { content: "served" });
    matchFixtureDiagnostic([fixture], divergentRequest(), undefined, undefined, { logger });
    matchFixtureDiagnostic([fixture], divergentRequest(), undefined, undefined, { logger });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("turnIndex relaxation: quiet on green", () => {
  it("canonical-position match (assistantCount === turnIndex) does not warn or flag relaxed", () => {
    const logger = fakeLogger();
    // assistantCount 1, fixture turnIndex 1 → canonical position, no divergence.
    const fixtures = [makeFixture({ userMessage: "diverge", turnIndex: 1 }, { content: "served" })];
    const diag = matchFixtureDiagnostic(fixtures, divergentRequest(), undefined, undefined, {
      logger,
    });
    expect(diag.fixture).not.toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(diag.turnIndexRelaxed).toBeFalsy();
    expect(diag.matchedBy).toBe("turnIndex");
  });

  it("non-relaxed match (no turnIndex on the fixture) does not warn or flag relaxed", () => {
    const logger = fakeLogger();
    const fixtures = [makeFixture({ userMessage: "diverge" }, { content: "served" })];
    const diag = matchFixtureDiagnostic(fixtures, divergentRequest(), undefined, undefined, {
      logger,
    });
    expect(diag.fixture).not.toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(diag.turnIndexRelaxed).toBeFalsy();
    expect(diag.matchedBy).toBe("content");
  });
});

// ---------------------------------------------------------------------------
// matchedBy accuracy: "turnIndex" must mean the selection was genuinely decided
// by a UNIQUE positional (turnIndex === assistantCount) criterion, not merely
// that the served fixture happens to carry turnIndex === assistantCount when a
// tie-break / registration-order rule actually chose it.
// ---------------------------------------------------------------------------
describe("turnIndex relaxation: matchedBy accuracy", () => {
  it("reports 'content' when the canonical-position serve was decided by tie-break, not unique position", () => {
    const logger = fakeLogger();
    // TWO content-matching fixtures both at the exact current position
    // (turnIndex 1 === assistantCount 1). selectByTurnIndex picks the
    // first by REGISTRATION ORDER (tie-break) — position did not uniquely
    // decide it — so matchedBy must be "content".
    const fixtures = [
      makeFixture({ userMessage: "diverge", turnIndex: 1 }, { content: "first" }),
      makeFixture({ userMessage: "diverge", turnIndex: 1 }, { content: "second" }),
    ];
    const diag = matchFixtureDiagnostic(fixtures, divergentRequest(), undefined, undefined, {
      logger,
    });
    expect(diag.fixture?.response).toEqual({ content: "first" });
    expect(diag.turnIndexRelaxed).toBeFalsy();
    expect(diag.matchedBy).toBe("content");
  });

  it("reports 'content' when an at-position fixture loses the exact-turn tie-break to an earlier fallback", () => {
    const logger = fakeLogger();
    // Earlier-registered plain fallback + a turnIndex-1 fixture at the exact
    // position. Tier 2 hands the exact-turn tie to the earlier fallback, so the
    // served fixture has no turnIndex → matchedBy "content" (already correct,
    // pinned as a regression guard).
    const fixtures = [
      makeFixture({ userMessage: "diverge" }, { content: "fallback" }),
      makeFixture({ userMessage: "diverge", turnIndex: 1 }, { content: "scripted" }),
    ];
    const diag = matchFixtureDiagnostic(fixtures, divergentRequest(), undefined, undefined, {
      logger,
    });
    expect(diag.fixture?.response).toEqual({ content: "fallback" });
    expect(diag.matchedBy).toBe("content");
  });

  it("reports 'turnIndex' for a genuine unique positional match", () => {
    const logger = fakeLogger();
    // A single fixture sitting at the exact current position with no competing
    // candidate — position uniquely decided the serve.
    const fixtures = [makeFixture({ userMessage: "diverge", turnIndex: 1 }, { content: "served" })];
    const diag = matchFixtureDiagnostic(fixtures, divergentRequest(), undefined, undefined, {
      logger,
    });
    expect(diag.fixture?.response).toEqual({ content: "served" });
    expect(diag.turnIndexRelaxed).toBeFalsy();
    expect(diag.matchedBy).toBe("turnIndex");
  });
});

// ---------------------------------------------------------------------------
// desc informativeness: the relaxed-warn message must identify the fixture
// meaningfully even when its match carries a predicate or RegExp (which
// JSON.stringify drops / collapses to {}). The message must NOT be the literal
// "{}" blob.
// ---------------------------------------------------------------------------
describe("turnIndex relaxation: warn desc informativeness", () => {
  it("names matcher KEYS (not '{}') for a predicate-only divergent fixture", () => {
    const logger = fakeLogger();
    // A predicate-gated fixture with turnIndex 0 → divergent at assistantCount
    // 1. JSON.stringify(match) drops the predicate fn and the response, so the
    // old descriptor read "served fixture {}". The new descriptor must surface
    // the matcher KEY names instead.
    const predicate = (req: ChatCompletionRequest) =>
      req.messages.some((m) => m.role === "user" && m.content === "diverge");
    const fixtures = [makeFixture({ predicate, turnIndex: 0 }, { content: "served" })];
    const diag = matchFixtureDiagnostic(fixtures, divergentRequest(), undefined, undefined, {
      logger,
    });
    expect(diag.fixture?.response).toEqual({ content: "served" });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const msg = String(logger.warn.mock.calls[0][0]);
    expect(msg).toContain("turnIndex relaxed");
    // The descriptor must NOT collapse to the empty-object blob.
    expect(msg).not.toContain("served fixture {}");
    // It must name the present matcher key.
    expect(msg).toContain("predicate");
  });

  it("summarizes a regex matcher value (no collapsed '{}' blob) for a regex divergent fixture", () => {
    const logger = fakeLogger();
    // A RegExp userMessage matcher serialises to `{}` under JSON.stringify, so
    // the legacy descriptor read `{"userMessage":{},"turnIndex":0}` — the key
    // name survives but the value is a meaningless empty object. The new
    // descriptor must summarize the matcher TYPE (e.g. `userMessage(regex)`)
    // rather than emit the collapsed `{}` value.
    const fixtures = [makeFixture({ userMessage: /diverge/, turnIndex: 0 }, { content: "served" })];
    const diag = matchFixtureDiagnostic(fixtures, divergentRequest(), undefined, undefined, {
      logger,
    });
    expect(diag.fixture?.response).toEqual({ content: "served" });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const msg = String(logger.warn.mock.calls[0][0]);
    // RED on the old JSON descriptor, which embedded the collapsed value blob.
    expect(msg).not.toContain('"userMessage":{}');
    expect(msg).toContain("userMessage");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the warn must fire through a real handler (server.ts), proving
// the logger is threaded via recordMatchOptions — and stay silent at the
// default (silent) log level so a passing programmatic run is not spammed.
// ---------------------------------------------------------------------------

describe("turnIndex relaxation: end-to-end through the real OpenAI handler", () => {
  let mock: LLMock | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  it("emits the relaxed warn via the logger at warn level when serving a divergent fixture", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mock = new LLMock({ port: 0, logLevel: "warn" });
    // turnIndex 0, but the request has one prior assistant bubble → divergent.
    mock.on({ userMessage: "e2e-diverge", turnIndex: 0 }, { content: "relaxed-serve" });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        stream: false,
        messages: [
          { role: "user", content: "e2e-diverge" },
          { role: "assistant", content: "prior turn" },
          { role: "user", content: "e2e-diverge" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0].message.content).toBe("relaxed-serve");

    const warned = warnSpy.mock.calls.some((c) =>
      c.some((a) => typeof a === "string" && a.includes("turnIndex relaxed")),
    );
    expect(warned).toBe(true);
  });

  it("stays silent at the default (silent) log level even when serving a divergent fixture", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mock = new LLMock({ port: 0 }); // default logLevel = silent
    mock.on({ userMessage: "e2e-quiet", turnIndex: 0 }, { content: "relaxed-serve" });
    await mock.start();

    const res = await fetch(`${mock.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4",
        stream: false,
        messages: [
          { role: "user", content: "e2e-quiet" },
          { role: "assistant", content: "prior turn" },
          { role: "user", content: "e2e-quiet" },
        ],
      }),
    });
    expect(res.status).toBe(200);

    const warned = warnSpy.mock.calls.some((c) =>
      c.some((a) => typeof a === "string" && a.includes("turnIndex relaxed")),
    );
    expect(warned).toBe(false);
  });
});
