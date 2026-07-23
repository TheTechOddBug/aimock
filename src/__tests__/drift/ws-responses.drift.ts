/**
 * OpenAI Responses API WebSocket drift tests.
 *
 * Three-way comparison: SDK types × real API (WS) × aimock output (WS).
 * The Responses WS protocol uses the same event shapes as HTTP SSE.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { compareSSESequences, formatDriftReport } from "./schema.js";
import {
  openaiResponsesTextEventShapes,
  openaiResponsesToolCallEventShapes,
} from "./sdk-shapes.js";
import { openaiResponsesWS, WSHandshakeError, extractWSErrorBody } from "./ws-providers.js";
import { resolveLiveModel, isInfraSkip, isModelNotFound, listOpenAIModels } from "./providers.js";
import { startDriftServer, stopDriftServer, collectMockWSMessages } from "./helpers.js";
import { connectWebSocket } from "../ws-test-client.js";

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

beforeAll(async () => {
  instance = await startDriftServer();
});

afterAll(async () => {
  await stopDriftServer(instance);
});

// ---------------------------------------------------------------------------
// Live model discovery
// ---------------------------------------------------------------------------

/**
 * Resolve a live, non-deprecated chat model for the Responses WS probe via
 * `GET /v1/models` (the same discovery `resolveLiveModel` generalizes from the
 * Cohere #325 pattern), preferring `gpt-4o-mini` but falling back to whatever
 * the account's listing exposes. Memoized per-key so both tests below make a
 * single listing call.
 */
function getResponsesWSModel() {
  return resolveLiveModel(
    "openai-responses-ws",
    async () => {
      const ids = await listOpenAIModels(OPENAI_API_KEY!);
      return { status: 200, models: ids.map((id) => ({ id })) };
    },
    ["gpt-4o-mini"],
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!OPENAI_API_KEY)("OpenAI Responses WS drift", () => {
  const config = { apiKey: OPENAI_API_KEY! };

  it("WS text event sequence and shapes match", async (ctx) => {
    const resolved = await getResponsesWSModel();
    if ("infra" in resolved) {
      // Provider-side auth/credit/rate-limit/5xx on the listing — honest skip.
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      throw new Error("OpenAI /v1/models exposed no usable chat model for the Responses WS probe");
    }
    const model = resolved.model;

    const sdkEvents = openaiResponsesTextEventShapes();

    // Real API via WS — a retired endpoint (handshake auth/rate/5xx) or a
    // stale/retired model id (in-band error frame) is an HONEST SKIP, never a
    // hard-fail that would quarantine the shared drift baseline.
    let realResult;
    try {
      realResult = await openaiResponsesWS(
        config,
        [{ role: "user", content: "Say hello" }],
        undefined,
        model,
      );
    } catch (err) {
      if (err instanceof WSHandshakeError && isInfraSkip(err.status)) {
        console.warn(`[ws-responses drift] WS handshake infra status ${err.status} — skipping`);
        ctx.skip();
        return;
      }
      throw err;
    }
    const errBody = extractWSErrorBody(realResult.rawMessages);
    if (errBody && isModelNotFound(400, errBody)) {
      console.warn(`[ws-responses drift] model-not-found: ${errBody} — skipping`);
      ctx.skip();
      return;
    }

    // Mock via WS — uses flat format matching real API
    const mockWs = await connectWebSocket(instance.url, "/v1/responses");
    mockWs.send(
      JSON.stringify({
        type: "response.create",
        model,
        input: [{ role: "user", content: "Say hello" }],
      }),
    );
    const mockResult = await collectMockWSMessages(mockWs, (msg) => {
      const m = msg as Record<string, unknown>;
      return m.type === "response.completed" || m.type === "response.done";
    });
    mockWs.close();

    expect(realResult.rawMessages.length, "Real API returned no WS messages").toBeGreaterThan(0);
    expect(mockResult.events.length, "Mock returned no WS messages").toBeGreaterThan(0);

    // Grade envelope SHAPE, never status/connection codes — the honest-skip
    // branches above already handled the non-shape failure modes.
    const diffs = compareSSESequences(sdkEvents, realResult.events, mockResult.events);
    const report = formatDriftReport(
      "OpenAI Responses WS (text events)",
      diffs,
      "openai-responses-ws",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("WS tool call event sequence matches", async (ctx) => {
    const resolved = await getResponsesWSModel();
    if ("infra" in resolved) {
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      throw new Error("OpenAI /v1/models exposed no usable chat model for the Responses WS probe");
    }
    const model = resolved.model;

    const sdkEvents = [
      ...openaiResponsesTextEventShapes().filter(
        (e) => e.type === "response.created" || e.type === "response.completed",
      ),
      ...openaiResponsesToolCallEventShapes(),
    ];

    const tools = [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];

    // Real API via WS
    let realResult;
    try {
      realResult = await openaiResponsesWS(
        config,
        [{ role: "user", content: "Weather in Paris" }],
        tools,
        model,
      );
    } catch (err) {
      if (err instanceof WSHandshakeError && isInfraSkip(err.status)) {
        console.warn(`[ws-responses drift] WS handshake infra status ${err.status} — skipping`);
        ctx.skip();
        return;
      }
      throw err;
    }
    const errBody = extractWSErrorBody(realResult.rawMessages);
    if (errBody && isModelNotFound(400, errBody)) {
      console.warn(`[ws-responses drift] model-not-found: ${errBody} — skipping`);
      ctx.skip();
      return;
    }

    // Mock via WS — uses flat format matching real API
    const mockWs = await connectWebSocket(instance.url, "/v1/responses");
    mockWs.send(
      JSON.stringify({
        type: "response.create",
        model,
        input: [{ role: "user", content: "Weather in Paris" }],
        tools,
      }),
    );
    const mockResult = await collectMockWSMessages(mockWs, (msg) => {
      const m = msg as Record<string, unknown>;
      return m.type === "response.completed" || m.type === "response.done";
    });
    mockWs.close();

    expect(realResult.rawMessages.length, "Real API returned no WS messages").toBeGreaterThan(0);
    expect(mockResult.events.length, "Mock returned no WS messages").toBeGreaterThan(0);

    const diffs = compareSSESequences(sdkEvents, realResult.events, mockResult.events);
    const report = formatDriftReport(
      "OpenAI Responses WS (tool call events)",
      diffs,
      "openai-responses-ws",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});
