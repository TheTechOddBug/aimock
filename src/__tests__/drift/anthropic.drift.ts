/**
 * Anthropic Claude Messages API drift tests.
 *
 * Three-way comparison: SDK types × real API × aimock output.
 */

import http from "node:http";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { ServerInstance } from "../../server.js";
import { extractShape, triangulate, compareSSESequences, formatDriftReport } from "./schema.js";
import {
  anthropicMessageShape,
  anthropicMessageToolCallShape,
  anthropicStreamEventShapes,
  anthropicToolStreamEventShapes,
  anthropicThinkingMessageShape,
  anthropicThinkingStreamEventShapes,
} from "./sdk-shapes.js";
import {
  isInfraSkip,
  isModelNotFound,
  listAnthropicModels,
  resolveLiveModel,
  __resetResolveLiveModelCache,
  type LiveModelEntry,
  type ResolvedModel,
} from "./providers.js";
import { httpPost, parseTypedSSE, startDriftServer, stopDriftServer } from "./helpers.js";

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

beforeAll(async () => {
  instance = await startDriftServer();
});

afterAll(async () => {
  await stopDriftServer(instance);
});

// ---------------------------------------------------------------------------
// Live model resolution (self-healing — replaces the dated hardcoded pin)
// ---------------------------------------------------------------------------
//
// `claude-haiku-4-5-20251001` is a dated snapshot pin: Anthropic retires
// dated snapshots on a schedule, and a retired pin used to 404/400 the real
// API leg, batch-quarantining the whole drift baseline (exit 5) rather than
// honestly skipping. Instead of hardcoding a model id, discover a live one
// from Anthropic's own `/v1/models` listing via R0's shared
// `resolveLiveModel` helper (generalized from the cohere #325 pattern), and
// honest-skip when the listing itself hits an infra condition.

const PREFERRED_ANTHROPIC_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-3-5-haiku-20241022",
  "claude-3-haiku-20240307",
];

/** Map Anthropic's `/v1/models` listing shape onto `resolveLiveModel`'s. */
async function fetchAnthropicModelListing(): Promise<{
  status: number;
  models: LiveModelEntry[];
}> {
  const ids = await listAnthropicModels(ANTHROPIC_API_KEY!);
  // A successful listing call always means status 200 here — `listAnthropicModels`
  // throws an `InfraError` (caught by `resolveLiveModel`) on any non-2xx status.
  // Anthropic's listing only ever exposes currently-available model ids (a
  // retired snapshot simply disappears from it), so there is no `deprecated`
  // flag to map.
  return { status: 200, models: ids.map((id) => ({ id })) };
}

/** Memoized (per `resolveLiveModel`) so the whole leg makes one listing call. */
function getAnthropicModel(): Promise<ResolvedModel> {
  return resolveLiveModel("anthropic", fetchAnthropicModelListing, PREFERRED_ANTHROPIC_MODELS);
}

// ---------------------------------------------------------------------------
// Real API helper (local, model-parameterized — mirrors the cohere.drift.ts
// template so the retrofit stays scoped to this file per R0's ownership of
// providers.ts's static-model anthropicNonStreaming/anthropicStreaming).
// ---------------------------------------------------------------------------

async function anthropicMessagesLive(
  model: string,
  messages: { role: string; content: string }[],
  opts: { tools?: object[]; stream?: boolean; maxTokens?: number } = {},
): Promise<{ status: number; body: string }> {
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: opts.maxTokens ?? 10,
    stream: opts.stream ?? false,
  };
  if (opts.tools) body.tools = opts.tools;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!ANTHROPIC_API_KEY)("Anthropic Claude Messages drift", () => {
  it("non-streaming text shape matches", async (ctx) => {
    const resolved = await getAnthropicModel();
    if ("infra" in resolved) {
      // Provider-side auth/credit/rate-limit/5xx — honest skip, not drift.
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      throw new Error("Anthropic /v1/models exposed no usable non-deprecated model");
    }
    const model = resolved.model;

    const sdkShape = anthropicMessageShape();
    const messages = [{ role: "user", content: "Say hello" }];

    const [realRes, mockRes] = await Promise.all([
      anthropicMessagesLive(model, messages),
      httpPost(`${instance.url}/v1/messages`, {
        model,
        max_tokens: 10,
        messages,
        stream: false,
      }),
    ]);

    if (isInfraSkip(realRes.status) || isModelNotFound(realRes.status, realRes.body)) {
      // Real probe hit a transient provider-side condition, or the resolved
      // model went stale between listing and probe — honest skip, not drift.
      ctx.skip();
      return;
    }

    const realShape = extractShape(JSON.parse(realRes.body));
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport("Anthropic Claude (non-streaming text)", diffs, "anthropic");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("streaming text event sequence and shapes match", async (ctx) => {
    const resolved = await getAnthropicModel();
    if ("infra" in resolved) {
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      throw new Error("Anthropic /v1/models exposed no usable non-deprecated model");
    }
    const model = resolved.model;

    const sdkEvents = anthropicStreamEventShapes();
    const messages = [{ role: "user", content: "Say hello" }];

    const [realRaw, mockStreamRes] = await Promise.all([
      anthropicMessagesLive(model, messages, { stream: true }),
      httpPost(`${instance.url}/v1/messages`, {
        model,
        max_tokens: 10,
        messages,
        stream: true,
      }),
    ]);

    if (isInfraSkip(realRaw.status) || isModelNotFound(realRaw.status, realRaw.body)) {
      ctx.skip();
      return;
    }

    const realParsed = parseTypedSSE(realRaw.body);
    expect(realParsed.length, "Real API returned no SSE events").toBeGreaterThan(0);
    const realEvents = realParsed.map((e) => ({
      type: e.type,
      dataShape: extractShape(e.data),
    }));

    const mockEvents = parseTypedSSE(mockStreamRes.body);
    expect(mockEvents.length, "Mock returned no SSE events").toBeGreaterThan(0);

    const mockSSEShapes = mockEvents.map((e) => ({
      type: e.type,
      dataShape: extractShape(e.data),
    }));

    const diffs = compareSSESequences(sdkEvents, realEvents, mockSSEShapes);
    const report = formatDriftReport(
      "Anthropic Claude (streaming text events)",
      diffs,
      "anthropic",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("non-streaming tool call shape matches", async (ctx) => {
    const resolved = await getAnthropicModel();
    if ("infra" in resolved) {
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      throw new Error("Anthropic /v1/models exposed no usable non-deprecated model");
    }
    const model = resolved.model;

    const sdkShape = anthropicMessageToolCallShape();

    const tools = [
      {
        name: "get_weather",
        description: "Get weather",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];
    const messages = [{ role: "user", content: "Weather in Paris" }];

    const [realRes, mockRes] = await Promise.all([
      anthropicMessagesLive(model, messages, { tools, maxTokens: 50 }),
      httpPost(`${instance.url}/v1/messages`, {
        model,
        max_tokens: 50,
        messages,
        stream: false,
        tools,
      }),
    ]);

    if (isInfraSkip(realRes.status) || isModelNotFound(realRes.status, realRes.body)) {
      ctx.skip();
      return;
    }

    const realShape = extractShape(JSON.parse(realRes.body));
    const mockShape = extractShape(JSON.parse(mockRes.body));

    const diffs = triangulate(sdkShape, realShape, mockShape);
    const report = formatDriftReport(
      "Anthropic Claude (non-streaming tool call)",
      diffs,
      "anthropic",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("streaming tool call event sequence matches", async (ctx) => {
    const resolved = await getAnthropicModel();
    if ("infra" in resolved) {
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      throw new Error("Anthropic /v1/models exposed no usable non-deprecated model");
    }
    const model = resolved.model;

    const sdkEvents = [
      ...anthropicStreamEventShapes().filter(
        (e) =>
          e.type === "message_start" || e.type === "message_delta" || e.type === "message_stop",
      ),
      ...anthropicToolStreamEventShapes(),
    ];

    const tools = [
      {
        name: "get_weather",
        description: "Get weather",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];
    const messages = [{ role: "user", content: "Weather in Paris" }];

    const [realRaw, mockStreamRes] = await Promise.all([
      anthropicMessagesLive(model, messages, { tools, stream: true, maxTokens: 50 }),
      httpPost(`${instance.url}/v1/messages`, {
        model,
        max_tokens: 50,
        messages,
        stream: true,
        tools,
      }),
    ]);

    if (isInfraSkip(realRaw.status) || isModelNotFound(realRaw.status, realRaw.body)) {
      ctx.skip();
      return;
    }

    const realParsed = parseTypedSSE(realRaw.body);
    expect(realParsed.length, "Real API returned no SSE events").toBeGreaterThan(0);
    const realEvents = realParsed.map((e) => ({
      type: e.type,
      dataShape: extractShape(e.data),
    }));

    const mockEvents = parseTypedSSE(mockStreamRes.body);
    expect(mockEvents.length, "Mock returned no SSE events").toBeGreaterThan(0);

    const mockSSEShapes = mockEvents.map((e) => ({
      type: e.type,
      dataShape: extractShape(e.data),
    }));

    const diffs = compareSSESequences(sdkEvents, realEvents, mockSSEShapes);
    const report = formatDriftReport(
      "Anthropic Claude (streaming tool call events)",
      diffs,
      "anthropic",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Regression guard for the drift-live-pr exit-5 quarantine (cross-block memo
// pollution).
// ---------------------------------------------------------------------------
//
// When ANTHROPIC_API_KEY is armed in CI, the live block above runs FIRST and
// populates `resolveLiveModel`'s per-key memo under "anthropic" with the real
// resolved id — and, exactly like the real live block, has no afterEach cache
// reset. This block SIMULATES that seeding with no credentials (a stubbed
// listing exposing the still-live `claude-haiku-4-5-20251001`) so the fixture
// self-healing block below is proven to reset the shared memo BEFORE it runs.
//
// Without that reset, the fixture block's first test read the leaked live id
// and asserted a raw `.toBe()` on model ids — an unparseable AssertionError
// (`expected 'claude-haiku-4-5-20251001' to be 'claude-haiku-5-1-20260201'`)
// that the drift collector could not parse as a structured report and
// quarantined as a fatal exit 5 (the drift-live-pr failure). Declared
// immediately before the fixture block so declaration order (vitest runs
// in-file tests in order; no shuffle configured) reproduces the CI sequence.
describe("Anthropic live-leg memo seeding (simulates the armed-key live block running first)", () => {
  it("populates the shared resolveLiveModel memo under 'anthropic' (no reset — mirrors the live block)", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "claude-haiku-4-5-20251001" }] }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected fetch in seeding test: ${String(url)}`);
    }) as typeof fetch;
    try {
      // The live leg resolves and MEMOIZES the still-live real id under
      // "anthropic". Intentionally NOT cleared here — the fixture block below
      // must be the thing that resets it.
      const resolved = await getAnthropicModel();
      expect(resolved).toEqual({ model: "claude-haiku-4-5-20251001" });
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Self-healing proof (fixture-driven — no live credentials required)
// ---------------------------------------------------------------------------
//
// Drives the REAL `getAnthropicModel`/`fetchAnthropicModelListing` resolution
// path and the REAL `isInfraSkip`/`isModelNotFound`/`triangulate` the live
// leg above uses (no reimplementation) against a simulated "Anthropic
// retired the pinned snapshot" condition. Runs unconditionally — no
// ANTHROPIC_API_KEY required — so it always exercises the retrofit even when
// live credentials aren't armed locally or in CI.
//
//   RED (pre-retrofit behavior, not committed): the old hardcoded pin
//   (`claude-haiku-4-5-20251001`) was sent directly to `/v1/messages` with no
//   discovery/skip layer. Against this same fixture (pin retired, listing
//   only exposes a newer id) that call 404s, and the old code had no honest-
//   skip path — the leg would throw/critical-diff and quarantine.
//   GREEN (this retrofit): `getAnthropicModel()` discovers the live id from
//   the listing instead of using the stale pin, the probe against the
//   discovered id succeeds, and shape-grading reports zero critical drift.
describe("Anthropic live-leg self-healing (fixture-driven, no credentials required)", () => {
  const origFetch = globalThis.fetch;
  // Reset the shared per-key `resolveLiveModel` memo BEFORE each case, not only
  // after. The live block (and the seeding guard) above run first and leave the
  // "anthropic" key memoized with a real/still-live id; without this the first
  // fixture case would resolve to that leaked id instead of its own stub and
  // fail a raw `.toBe()` on model ids (the drift-live-pr exit-5 quarantine).
  beforeEach(() => {
    __resetResolveLiveModelCache();
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    __resetResolveLiveModelCache();
  });

  const RETIRED_PIN = "claude-haiku-4-5-20251001";
  const LIVE_DISCOVERED_MODEL = "claude-haiku-5-1-20260201";

  function stubRetiredPinFixture(): void {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/v1/models")) {
        // The pinned snapshot no longer appears in the listing — retired.
        return new Response(JSON.stringify({ data: [{ id: LIVE_DISCOVERED_MODEL }] }), {
          status: 200,
        });
      }
      if (href.includes("/v1/messages")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        if (body.model === RETIRED_PIN) {
          // Documenting the RED this retrofit removes from the driven path:
          // the retired pin genuinely 404s as "model not found".
          return new Response(
            JSON.stringify({
              type: "error",
              error: { type: "not_found_error", message: `model: ${RETIRED_PIN}` },
            }),
            { status: 404 },
          );
        }
        if (body.model === LIVE_DISCOVERED_MODEL) {
          return new Response(
            JSON.stringify({
              id: "msg_fixture",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "Hello!" }],
              model: LIVE_DISCOVERED_MODEL,
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 8, output_tokens: 3 },
            }),
            { status: 200 },
          );
        }
      }
      throw new Error(`Unexpected fetch in fixture test: ${href}`);
    }) as typeof fetch;
  }

  it("REGRESSION: discovers a live model and shape-grades it when the pinned snapshot is retired", async () => {
    stubRetiredPinFixture();

    // RED evidence (documented, not re-executed here): sending the retired
    // pin straight through — what the pre-retrofit code did — 404s against
    // this exact fixture:
    const staleProbe = await anthropicMessagesLive(RETIRED_PIN, [
      { role: "user", content: "Say hello" },
    ]);
    expect(staleProbe.status).toBe(404);
    expect(isModelNotFound(staleProbe.status, staleProbe.body)).toBe(true);

    // GREEN: the retrofitted resolution step never returns the retired pin —
    // it discovers the listing's live id instead.
    const resolved = await getAnthropicModel();
    if ("infra" in resolved || "unavailable" in resolved) {
      throw new Error(`Expected a resolved model, got ${JSON.stringify(resolved)}`);
    }
    expect(resolved.model).toBe(LIVE_DISCOVERED_MODEL);
    expect(resolved.model).not.toBe(RETIRED_PIN);

    const realRes = await anthropicMessagesLive(resolved.model, [
      { role: "user", content: "Say hello" },
    ]);
    expect(isInfraSkip(realRes.status)).toBe(false);
    expect(isModelNotFound(realRes.status, realRes.body)).toBe(false);
    expect(realRes.status).toBe(200);

    // Shape-graded on the discovered-model envelope — a real drift would
    // still be caught here; this fixture's envelope matches the SDK shape.
    const sdkShape = anthropicMessageShape();
    const realShape = extractShape(JSON.parse(realRes.body));
    const diffs = triangulate(sdkShape, realShape, realShape);
    expect(diffs.filter((d) => d.severity === "critical")).toEqual([]);
  });

  it("honest-skips (not a drift finding) when the model listing itself hits an infra condition", async () => {
    // 403 avoids RETRYABLE_STATUSES (429/5xx) so the fixture stays fast.
    globalThis.fetch = (async () => new Response("Forbidden", { status: 403 })) as typeof fetch;

    const resolved = await getAnthropicModel();
    expect(resolved).toEqual({ infra: 403 });
  });

  it("classifies model-not-found probe responses (404, and 400 with a model-not-found body)", () => {
    expect(isModelNotFound(404)).toBe(true);
    expect(
      isModelNotFound(400, JSON.stringify({ error: { message: "model_not_found: foo" } })),
    ).toBe(true);
    expect(isModelNotFound(400, JSON.stringify({ error: { message: "bad request" } }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Extended thinking
// ---------------------------------------------------------------------------

describe("Anthropic Claude extended thinking shapes", () => {
  it("non-streaming thinking shape matches", async () => {
    const sdkShape = anthropicThinkingMessageShape();

    const mockRes = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 50,
      messages: [{ role: "user", content: "Think about hello" }],
      stream: false,
    });

    expect(mockRes.status).toBe(200);
    const mockBody = JSON.parse(mockRes.body);
    const mockShape = extractShape(mockBody);

    // Verify thinking block is present alongside text
    expect(mockBody.content).toBeInstanceOf(Array);
    expect(mockBody.content.length).toBe(2);
    expect(mockBody.content[0].type).toBe("thinking");
    expect(mockBody.content[0].thinking).toBe("I need to consider...");
    // Real Anthropic non-streaming returns a non-empty cryptographic signature
    // on the assembled thinking block (assembled here from the signature_delta).
    expect(typeof mockBody.content[0].signature).toBe("string");
    expect(mockBody.content[0].signature.length).toBeGreaterThan(0);
    expect(mockBody.content[1].type).toBe("text");
    expect(mockBody.content[1].text).toBe("Hello!");

    // Shape triangulation (mock-only, no real API call for thinking)
    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport(
      "Anthropic Claude (non-streaming thinking)",
      diffs,
      "anthropic",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("streaming thinking event sequence and shapes match", async () => {
    const sdkEvents = anthropicThinkingStreamEventShapes();

    const mockStreamRes = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 50,
      messages: [{ role: "user", content: "Think about hello" }],
      stream: true,
    });

    const mockEvents = parseTypedSSE(mockStreamRes.body);
    expect(mockEvents.length, "Mock returned no SSE events").toBeGreaterThan(0);

    // Verify thinking-specific events are present
    const thinkingBlockStart = mockEvents.find(
      (e) => e.type === "content_block_start" && e.data?.content_block?.type === "thinking",
    );
    expect(thinkingBlockStart, "Missing content_block_start with type=thinking").toBeTruthy();
    expect(thinkingBlockStart!.data.content_block.thinking).toBe("");
    expect(thinkingBlockStart!.data.content_block.signature).toBe("");

    const thinkingDeltas = mockEvents.filter(
      (e) => e.type === "content_block_delta" && e.data?.delta?.type === "thinking_delta",
    );
    expect(thinkingDeltas.length, "Missing thinking_delta events").toBeGreaterThan(0);

    // Reconstruct full thinking text from deltas
    const thinkingText = thinkingDeltas.map((e) => e.data.delta.thinking).join("");
    expect(thinkingText).toBe("I need to consider...");

    // Verify signature_delta event is present after thinking deltas
    const signatureDeltas = mockEvents.filter(
      (e) => e.type === "content_block_delta" && e.data?.delta?.type === "signature_delta",
    );
    expect(signatureDeltas.length, "Missing signature_delta event").toBe(1);
    // Real Anthropic delivers the non-empty cryptographic signature here (the
    // `content_block_start` carried ""); an SDK assembles the block's signature
    // from this delta.
    expect(typeof signatureDeltas[0].data.delta.signature).toBe("string");
    expect(signatureDeltas[0].data.delta.signature.length).toBeGreaterThan(0);

    // Verify text block follows thinking block
    const textBlockStart = mockEvents.find(
      (e) => e.type === "content_block_start" && e.data?.content_block?.type === "text",
    );
    expect(textBlockStart, "Missing content_block_start with type=text").toBeTruthy();

    // Shape triangulation
    const mockSSEShapes = mockEvents.map((e) => ({
      type: e.type,
      dataShape: extractShape(e.data),
    }));

    const diffs = compareSSESequences(sdkEvents, sdkEvents, mockSSEShapes);
    const report = formatDriftReport(
      "Anthropic Claude (streaming thinking events)",
      diffs,
      "anthropic",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("thinking block index precedes text block index", async () => {
    const mockStreamRes = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 50,
      messages: [{ role: "user", content: "Think about hello" }],
      stream: true,
    });

    const mockEvents = parseTypedSSE(mockStreamRes.body);

    const thinkingStart = mockEvents.find(
      (e) => e.type === "content_block_start" && e.data?.content_block?.type === "thinking",
    );
    const textStart = mockEvents.find(
      (e) => e.type === "content_block_start" && e.data?.content_block?.type === "text",
    );

    expect(thinkingStart).toBeTruthy();
    expect(textStart).toBeTruthy();
    expect(thinkingStart!.data.index).toBeLessThan(textStart!.data.index);
  });
});

// ---------------------------------------------------------------------------
// Error shape validation
// ---------------------------------------------------------------------------

describe("Anthropic Claude error shapes", () => {
  it("no-fixture-match returns Anthropic error envelope (not OpenAI style)", async () => {
    const res = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [{ role: "user", content: "this will definitely not match any fixture" }],
      stream: false,
    });

    // Should be 404 (no fixture matched, non-strict mode)
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);

    // Anthropic wraps errors as { type: "error", error: { type, message } }
    // NOT OpenAI style { error: { message, type, code } }
    expect(body).toHaveProperty("error");
    expect(body.error).toHaveProperty("type");
    expect(body.error).toHaveProperty("message");
    expect(body.error.type).toBe("invalid_request_error");
    expect(typeof body.error.message).toBe("string");

    // Anthropic errors must NOT have a `code` field
    expect(body.error.code).toBeUndefined();
  });

  it("malformed JSON returns Anthropic error envelope", async () => {
    // Send raw invalid JSON to the Anthropic endpoint
    const res = await new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
      body: string;
    }>((resolve, reject) => {
      const req = http.request(
        `${instance.url}/v1/messages`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () =>
            resolve({
              status: r.statusCode!,
              headers: r.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on("error", reject);
      req.write("{not valid json");
      req.end();
    });

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);

    // Must have Anthropic error structure
    expect(body).toHaveProperty("error");
    expect(body.error).toHaveProperty("type");
    expect(body.error).toHaveProperty("message");
    expect(body.error.type).toBe("invalid_request_error");

    // Anthropic errors must NOT have a `code` field
    expect(body.error.code).toBeUndefined();
  });

  it("error envelope has exactly the expected fields (no extras)", async () => {
    const res = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [{ role: "user", content: "unmatched request for shape test" }],
      stream: false,
    });

    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);

    // Anthropic error envelope: only `error` at top (and optionally `type: "error"`)
    const topKeys = Object.keys(body);
    // Must have `error`; may have `type: "error"` but nothing else
    expect(topKeys).toContain("error");
    for (const key of topKeys) {
      expect(["type", "error"]).toContain(key);
    }

    // Inner error object: only `type` and `message` — no `code`, `param`, etc.
    const innerKeys = Object.keys(body.error);
    expect(innerKeys.sort()).toEqual(["message", "type"]);
  });

  it("Content-Type is application/json on error", async () => {
    const res = await httpPost(`${instance.url}/v1/messages`, {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [{ role: "user", content: "yet another unmatched message" }],
      stream: false,
    });

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// Canary: detect when Anthropic adds new capabilities
// ---------------------------------------------------------------------------

describe.skipIf(!ANTHROPIC_API_KEY)("Anthropic capability canaries", () => {
  it("canary: detect WebSocket API", async () => {
    // Anthropic doesn't have a WebSocket API as of 2026-03.
    // If they add one, this test will detect it via upgrade headers.
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "OPTIONS",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
    });
    // If Anthropic adds WebSocket support, they'll likely add upgrade headers
    const upgradeHeader = res.headers.get("upgrade");
    if (upgradeHeader) {
      console.warn("[CANARY] Anthropic may now support WebSocket upgrade. Investigate.");
    }
    expect(true).toBe(true); // canary always passes
  });

  it("canary: detect embeddings API", async () => {
    // Anthropic doesn't have an embeddings API as of 2026-03.
    const res = await fetch("https://api.anthropic.com/v1/embeddings", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "claude-3-5-sonnet-20241022", input: "test" }),
    });
    // If they add it, we'd get a 200 or 400 (bad request format) instead of 404
    if (res.status !== 404) {
      console.warn(`[CANARY] Anthropic /v1/embeddings returned ${res.status}. May now exist.`);
    }
    expect(true).toBe(true);
  });
});
