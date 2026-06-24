import { describe, it, test, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { matchFixture, matchFixtureDiagnostic, getTextContent, getSystemText } from "../router.js";
import { LLMock } from "../llmock.js";
import type { ChatCompletionRequest, Fixture } from "../types.js";

// ===========================================================================
// CR fixes for the content-anchored fixture-matching change. One concern:
// the content-anchored selection logic + record-path wiring must be correct.
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

// ---------------------------------------------------------------------------
// F2 — selectByTurnIndex asymmetry + registration-order break
// ---------------------------------------------------------------------------

describe("F2: future-turn guard applied uniformly (single + multi candidate)", () => {
  it("single content-matching fixture whose turnIndex is AHEAD of the conversation does not answer an at-turn-0 request via the relaxed path", () => {
    // A lone candidate at turnIndex 3 must NOT answer an at-turn-0 request when
    // there is no other eligible candidate — same future-turn guard the
    // multi-candidate path enforces. (Replay: such a fixture is the only
    // content match, so the contract DOES serve it; this asserts that the
    // single-candidate path and the multi-candidate path agree on a request
    // that has a non-turn fallback alternative.)
    const fixtures = [
      makeFixture({ userMessage: "step", turnIndex: 3 }, { content: "future" }),
      makeFixture({ userMessage: "step" }, { content: "fallback" }),
    ];
    // assistantCount 0; turnIndex 3 is ahead → the non-turn fallback must win,
    // not the future-turn fixture.
    const got = matchFixture(fixtures, makeReq({ messages: [{ role: "user", content: "step" }] }));
    expect(got?.response).toEqual({ content: "fallback" });
  });
});

describe("F2: registration order preserved among equally-eligible candidates", () => {
  it("a later-registered turnIndex'd fixture does NOT override an earlier-registered non-turnIndex'd one when both are eligible", () => {
    // Both are content matches and both are eligible at assistantCount 0
    // (turnIndex 0 <= 0). The first-registered fixture must win (registration
    // order tie-break), regardless of which one carries a turnIndex.
    const fixtures = [
      makeFixture({ userMessage: "tie" }, { content: "first-registered" }),
      makeFixture({ userMessage: "tie", turnIndex: 0 }, { content: "second-registered" }),
    ];
    const got = matchFixture(fixtures, makeReq({ messages: [{ role: "user", content: "tie" }] }));
    expect(got?.response).toEqual({ content: "first-registered" });
  });
});

// ---------------------------------------------------------------------------
// F3 — fallback must not serve a future-turn fixture
// ---------------------------------------------------------------------------

describe("F3: fallback does not serve a future-turn fixture to an at-turn-0 request", () => {
  it("a turn-3 fixture must not answer an at-turn-0 request when a fallback alternative exists", () => {
    const fixtures = [
      makeFixture({ userMessage: "go", turnIndex: 3 }, { content: "turn-3" }),
      makeFixture({ userMessage: "go", turnIndex: 5 }, { content: "turn-5" }),
      makeFixture({ userMessage: "go" }, { content: "plain-fallback" }),
    ];
    // assistantCount 0; every turnIndexed candidate (3, 5) is ahead → the plain
    // fallback answers, NOT the lowest future turn.
    const got = matchFixture(fixtures, makeReq({ messages: [{ role: "user", content: "go" }] }));
    expect(got?.response).toEqual({ content: "plain-fallback" });
  });
});

// ---------------------------------------------------------------------------
// F4 — text-join + empty-handling consistency
// ---------------------------------------------------------------------------

describe("F4: getTextContent / getSystemText consistent multi-part + empty handling", () => {
  it("empty-string string content and empty-text array content are treated the same (both null/empty)", () => {
    // String "" historically returns "" (skipped via !text); array of only
    // empty text returns null. After the fix both collapse to the same empty
    // semantic so content matching is symmetric.
    const fromString = getTextContent("");
    const fromArray = getTextContent([{ type: "text", text: "" }]);
    expect(Boolean(fromString)).toBe(false);
    expect(Boolean(fromArray)).toBe(false);
  });

  it("getSystemText joins multi-part text within a single system message the same way getTextContent does", () => {
    const joined = getTextContent([
      { type: "text", text: "alpha" },
      { type: "text", text: "beta" },
    ]);
    const sys = getSystemText([
      {
        role: "system",
        content: [
          { type: "text", text: "alpha" },
          { type: "text", text: "beta" },
        ],
      },
    ]);
    // A single system message's parts must read identically through both paths.
    expect(sys).toBe(joined);
  });

  it("systemMessage:[] matches unconditionally even when the request has no system text (F5 fold)", () => {
    const fixtures = [makeFixture({ systemMessage: [] }, { content: "unconditional" })];
    // No system message at all — the empty-array contract is "no constraint".
    const got = matchFixture(fixtures, makeReq({ messages: [{ role: "user", content: "x" }] }));
    expect(got?.response).toEqual({ content: "unconditional" });
  });
});

// ---------------------------------------------------------------------------
// F1 — sequenceIndex consumed by a declined fixture
// ---------------------------------------------------------------------------

describe("F1: sequence match-count bumps only for the SELECTED fixture", () => {
  it("a sequenced fixture that passes its gate but is NOT served by selectByTurnIndex is not consumed", async () => {
    const mock = new LLMock();
    await mock.start();
    try {
      mock.reset();
      // A turnIndex'd fixture B (registered FIRST so it wins the position tie)
      // AND a sequenced fixture A at sequenceIndex 0 that also content-matches.
      // At assistantCount 1, selectByTurnIndex serves B (turnIndex 1 == count,
      // registered first). A passed its sequence gate (count 0 == index 0) but
      // must NOT have its count consumed, because B — not A — was served.
      mock.on({ userMessage: "seq", turnIndex: 1 }, { content: "B-turn-1" });
      mock.on({ userMessage: "seq", sequenceIndex: 0 }, { content: "A-seq-0" });
      mock.on({ userMessage: "seq", sequenceIndex: 1 }, { content: "A-seq-1" });

      // assistantCount 1 → B (turnIndex 1) is the closest scripted turn → served.
      const res1 = await fetch(`${mock.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4",
          stream: false,
          messages: [
            { role: "user", content: "seq" },
            { role: "assistant", content: "prior" },
            { role: "user", content: "seq" },
          ],
        }),
      });
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as { choices: { message: { content: string } }[] };
      expect(body1.choices[0].message.content).toBe("B-turn-1");

      // Now an at-turn-0 request: sequence A must STILL be at index 0 (not
      // consumed by the prior request which served B). So we get A-seq-0.
      const res2 = await fetch(`${mock.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4",
          stream: false,
          messages: [{ role: "user", content: "seq" }],
        }),
      });
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as { choices: { message: { content: string } }[] };
      // If the prior request had wrongly consumed A's index, this would serve
      // A-seq-1 instead. Correct behavior: A is untouched → A-seq-0.
      expect(body2.choices[0].message.content).toBe("A-seq-0");
    } finally {
      await mock.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// F6 — strictTurnIndex wired on ALL record-capable handlers (not just OpenAI)
// ---------------------------------------------------------------------------

interface FakeUpstream {
  url: string;
  close: () => Promise<void>;
  getHits: () => number;
}

function startAnthropicUpstream(): Promise<FakeUpstream> {
  let hits = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        void raw;
        hits++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_rec",
            type: "message",
            role: "assistant",
            model: "claude-3-5-sonnet-20241022",
            content: [{ type: "text", text: "recorded-second-turn" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
        getHits: () => hits,
      });
    });
  });
}

describe("F6: record mode strictTurnIndex wired on the Anthropic (non-OpenAI) handler", () => {
  let mock: LLMock | undefined;
  let upstream: Awaited<ReturnType<typeof startAnthropicUpstream>> | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
    await upstream?.close();
    upstream = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  test("an earlier-turn fixture must NOT shadow a longer record request → the new turn IS proxied/recorded", async () => {
    upstream = await startAnthropicUpstream();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-anthropic-record-"));
    mock = new LLMock({
      port: 0,
      record: { providers: { anthropic: upstream!.url }, fixturePath: tmpDir },
    });
    await mock.start();

    // A turnIndex-0 fixture that content-matches the user message. A longer
    // (turn-1) request arrives. Under the BUGGY default (strictTurnIndex
    // unset on this handler), the turn-0 fixture content-shadows the longer
    // request → fixture served → recording never fires. With strictTurnIndex
    // wired (record mode), turn-0 != turn-1 → MISS → proxy + record.
    mock.on({ userMessage: "record-me", turnIndex: 0 }, { content: "stale-turn-0" });

    const res = await fetch(`${mock.url}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        stream: false,
        messages: [
          { role: "user", content: "record-me" },
          { role: "assistant", content: "first turn" },
          { role: "user", content: "record-me" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: { type: string; text: string }[] };
    // Must be the freshly recorded upstream turn, NOT the stale turn-0 fixture.
    expect(body.content[0].text).toBe("recorded-second-turn");
    // Upstream WAS hit (the new turn was proxied + recorded).
    expect(upstream!.getHits()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// F6 (unit) — matcher-level proof the shared MatchOptions builder is honored
// ---------------------------------------------------------------------------

describe("F6 (unit): strictTurnIndex makes an earlier-turn fixture MISS a longer request", () => {
  it("default (false) shadows; strict (true) misses → record branch can fire", () => {
    const fixtures = [makeFixture({ userMessage: "rec", turnIndex: 0 }, { content: "turn-0" })];
    const longer = makeReq({
      messages: [
        { role: "user", content: "rec" },
        { role: "assistant", content: "a" },
        { role: "user", content: "rec" },
      ],
    });
    // Replay default: the lone content match is served (false-red kill).
    const replayed = matchFixtureDiagnostic(fixtures, longer);
    expect(replayed.fixture).not.toBeNull();
    // Record (strict): turn-0 != turn-1 → MISS so the handler proxies + records.
    const recorded = matchFixtureDiagnostic(fixtures, longer, undefined, undefined, {
      strictTurnIndex: true,
    });
    expect(recorded.fixture).toBeNull();
  });
});
