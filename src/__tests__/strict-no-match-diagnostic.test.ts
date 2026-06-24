import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { matchFixtureDiagnostic } from "../router.js";
import { strictNoMatchMessage } from "../helpers.js";
import { createServer, type ServerInstance } from "../server.js";
import type { Fixture, ChatCompletionRequest } from "../types.js";
import { SKIPPED_BY_STATE_RE } from "./helpers/strict-matchers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function httpPost(
  url: string,
  body: object,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function chatRequest(userContent: string): ChatCompletionRequest {
  return {
    model: "gpt-4",
    messages: [{ role: "user", content: userContent }],
  };
}

// ---------------------------------------------------------------------------
// Unit tests: strictNoMatchMessage helper
// ---------------------------------------------------------------------------

describe("strictNoMatchMessage", () => {
  it("returns the generic no-match message when nothing was skipped", () => {
    expect(strictNoMatchMessage(0)).toBe("Strict mode: no fixture matched");
  });

  it("reports the skipped-by-state count when candidates were skipped", () => {
    expect(strictNoMatchMessage(1)).toBe(
      "Strict mode: 1 candidate fixture(s) skipped by sequence/turn state",
    );
    expect(strictNoMatchMessage(3)).toBe(
      "Strict mode: 3 candidate fixture(s) skipped by sequence/turn state",
    );
  });
});

// ---------------------------------------------------------------------------
// Unit tests: matchFixtureDiagnostic
// ---------------------------------------------------------------------------

describe("matchFixtureDiagnostic", () => {
  it("reports zero skipped when no fixture matches the request shape", () => {
    const fixtures: Fixture[] = [{ match: { userMessage: "hello" }, response: { content: "hi" } }];
    const result = matchFixtureDiagnostic(fixtures, chatRequest("totally different"));
    expect(result.fixture).toBeNull();
    expect(result.skippedBySequenceOrTurn).toBe(0);
  });

  it("returns the fixture (skipped 0) when one matches", () => {
    const fixtures: Fixture[] = [{ match: { userMessage: "hello" }, response: { content: "hi" } }];
    const result = matchFixtureDiagnostic(fixtures, chatRequest("hello"));
    expect(result.fixture).not.toBeNull();
    expect(result.skippedBySequenceOrTurn).toBe(0);
  });

  it("counts a fixture that matched the shape but failed the sequenceIndex gate", () => {
    const fixture: Fixture = {
      match: { userMessage: "hello", sequenceIndex: 0 },
      response: { content: "hi" },
    };
    // Pretend it has already been consumed once (count → 1) so sequenceIndex 0 no longer matches.
    const matchCounts = new Map<Fixture, number>([[fixture, 1]]);
    const result = matchFixtureDiagnostic([fixture], chatRequest("hello"), matchCounts);
    expect(result.fixture).toBeNull();
    expect(result.skippedBySequenceOrTurn).toBe(1);
  });

  it("does NOT skip a uniquely content-matching fixture on a turnIndex mismatch (content-anchored replay)", () => {
    const fixture: Fixture = {
      match: { userMessage: "hello", turnIndex: 1 },
      response: { content: "hi" },
    };
    // Request has zero assistant turns, but turnIndex is a non-fatal
    // disambiguator on the replay path — a fixture that is the only content
    // match must not be rejected for an off-by-N assistant count. It matches,
    // and nothing is "skipped by sequence/turn state".
    const result = matchFixtureDiagnostic([fixture], chatRequest("hello"));
    expect(result.fixture).toBe(fixture);
    expect(result.skippedBySequenceOrTurn).toBe(0);
  });

  it("keeps turnIndex a strict skip gate under strictTurnIndex (record mode)", () => {
    const fixture: Fixture = {
      match: { userMessage: "hello", turnIndex: 1 },
      response: { content: "hi" },
    };
    // In record mode a miss proxies upstream to capture the new turn, so an
    // earlier-turn capture must not shadow a longer request — turnIndex stays
    // an exact reject gate and the shape-matching candidate is counted skipped.
    const result = matchFixtureDiagnostic([fixture], chatRequest("hello"), undefined, undefined, {
      strictTurnIndex: true,
    });
    expect(result.fixture).toBeNull();
    expect(result.skippedBySequenceOrTurn).toBe(1);
  });

  it("does NOT count a fixture that fails a shape predicate (wrong userMessage)", () => {
    const fixture: Fixture = {
      match: { userMessage: "hello", sequenceIndex: 0 },
      response: { content: "hi" },
    };
    const matchCounts = new Map<Fixture, number>([[fixture, 1]]);
    // userMessage does not match → shape predicate fails before the seq gate.
    const result = matchFixtureDiagnostic([fixture], chatRequest("goodbye"), matchCounts);
    expect(result.fixture).toBeNull();
    expect(result.skippedBySequenceOrTurn).toBe(0);
  });

  it("matches a sequenceIndex fixture on every request (skipped 0) when matchCounts is omitted", () => {
    // The sequenceIndex gate only engages when BOTH match.sequenceIndex AND a
    // matchCounts map are provided. Without matchCounts there is no count state,
    // so even an otherwise-unreachable index matches every request and never
    // contributes to skippedBySequenceOrTurn.
    const fixture: Fixture = {
      match: { userMessage: "hello", sequenceIndex: 5 },
      response: { content: "hi" },
    };
    const first = matchFixtureDiagnostic([fixture], chatRequest("hello"));
    expect(first.fixture).toBe(fixture);
    expect(first.skippedBySequenceOrTurn).toBe(0);
    // Replay: still matches — no matchCounts means no state to exhaust.
    const second = matchFixtureDiagnostic([fixture], chatRequest("hello"));
    expect(second.fixture).toBe(fixture);
    expect(second.skippedBySequenceOrTurn).toBe(0);
  });

  it("returns the later matching fixture AND a positive skip count when an earlier candidate was skipped by state", () => {
    const exhausted: Fixture = {
      match: { userMessage: "hello", sequenceIndex: 0 },
      response: { content: "first" },
    };
    const fallback: Fixture = {
      match: { userMessage: "hello" },
      response: { content: "second" },
    };
    // The first candidate matched the shape but its sequence count moved on;
    // the second candidate matches outright. Both facts surface in the result.
    const matchCounts = new Map<Fixture, number>([[exhausted, 1]]);
    const result = matchFixtureDiagnostic([exhausted, fallback], chatRequest("hello"), matchCounts);
    expect(result.fixture).toBe(fallback);
    expect(result.skippedBySequenceOrTurn).toBe(1);
  });

  it("does NOT count a fixture that fails the hasToolResult shape predicate even when a state gate also fails", () => {
    // The fixture fails BOTH a SHAPE predicate (hasToolResult: true, but the
    // request has no tool message) AND a STATE gate (sequenceIndex: 1 while the
    // count is 0). Because hasToolResult is a request-shape predicate, the
    // fixture's shape never matched, so it must NOT be counted as
    // "skipped by sequence/turn state".
    const fixture: Fixture = {
      match: { userMessage: "hello", hasToolResult: true, sequenceIndex: 1 },
      response: { content: "hi" },
    };
    // count state 0 → sequenceIndex: 1 would fail the state gate.
    const matchCounts = new Map<Fixture, number>([[fixture, 0]]);
    // Request has a user message but NO tool message → hasToolResult shape fails.
    const result = matchFixtureDiagnostic([fixture], chatRequest("hello"), matchCounts);
    expect(result.fixture).toBeNull();
    expect(result.skippedBySequenceOrTurn).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: strict-503 message disambiguation (HTTP contract)
// ---------------------------------------------------------------------------

describe("strict-mode 503 sequence/turn disambiguation", () => {
  let server: ServerInstance | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.server.close(() => resolve()));
      server = null;
    }
  });

  it("no fixture at all → generic no-match message (503, envelope intact)", async () => {
    const fixtures: Fixture[] = [{ match: { userMessage: "hello" }, response: { content: "hi" } }];
    server = await createServer(fixtures, { port: 0, strict: true });
    const res = await httpPost(`${server.url}/v1/chat/completions`, chatRequest("unmatched"));
    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe("Strict mode: no fixture matched");
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("sequence exhausted → skipped-by-state message (503, envelope intact)", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello", sequenceIndex: 0 }, response: { content: "hi" } },
    ];
    server = await createServer(fixtures, { port: 0, strict: true });
    // First call consumes the sequenceIndex:0 fixture (count → 1).
    const first = await httpPost(`${server.url}/v1/chat/completions`, chatRequest("hello"));
    expect(first.status).toBe(200);
    // Replay the same request: the fixture matched the shape but is skipped by seq state.
    const res = await httpPost(`${server.url}/v1/chat/completions`, chatRequest("hello"));
    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(SKIPPED_BY_STATE_RE);
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("turnIndex mismatch on a unique content match → 200 (content-anchored replay, no false strict miss)", async () => {
    const fixtures: Fixture[] = [
      { match: { userMessage: "hello", turnIndex: 1 }, response: { content: "hi" } },
    ];
    // No record config → replay path. The request has 0 assistant turns but the
    // fixture is the only content match, so the relaxed turnIndex disambiguator
    // matches it instead of producing a false strict-mode 503 ("empty assistant
    // response"). This is the regression this matcher change fixes.
    server = await createServer(fixtures, { port: 0, strict: true });
    const res = await httpPost(`${server.url}/v1/chat/completions`, chatRequest("hello"));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.choices[0].message.content).toBe("hi");
  });

  it("invokes a stateful match.predicate EXACTLY ONCE on the strict no-match path", async () => {
    let predicateCalls = 0;
    const fixtures: Fixture[] = [
      {
        match: {
          // Predicate increments a counter and never matches, forcing the
          // strict no-match (503) branch. A double-pass matcher would invoke
          // this predicate twice (initial match + diagnostic re-run).
          predicate: () => {
            predicateCalls++;
            return false;
          },
        },
        response: { content: "never returned" },
      },
    ];
    server = await createServer(fixtures, { port: 0, strict: true });
    const res = await httpPost(`${server.url}/v1/chat/completions`, chatRequest("anything"));
    expect(res.status).toBe(503);
    expect(predicateCalls).toBe(1);
  });
});
