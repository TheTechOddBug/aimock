/**
 * Cohere drift tests.
 *
 * Three-way comparison: expected shape x real API x aimock output.
 * Covers /v2/chat non-streaming and streaming endpoints.
 *
 * Requires: COHERE_API_KEY
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerInstance } from "../../server.js";
import { extractShape, triangulate, formatDriftReport } from "./schema.js";
import {
  httpPost,
  httpPostRaw,
  parseDataOnlySSE,
  startDriftServer,
  stopDriftServer,
} from "./helpers.js";
import {
  COHERE_BASE_URL,
  isInfraStatus,
  selectCohereChatModel,
  type CohereModelEntry,
} from "./cohere-model.js";

// ---------------------------------------------------------------------------
// Credentials check
// ---------------------------------------------------------------------------

const COHERE_API_KEY = process.env.COHERE_API_KEY;
const HAS_CREDENTIALS = !!COHERE_API_KEY;

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;

beforeAll(async () => {
  instance = await startDriftServer();
});

afterAll(async () => {
  await stopDriftServer(instance);
});

// ---------------------------------------------------------------------------
// SDK shape stubs
// ---------------------------------------------------------------------------

/**
 * Minimal Cohere /v2/chat response shape (non-streaming).
 */
function cohereChatResponseShape() {
  return extractShape({
    id: "chat-abc123",
    finish_reason: "COMPLETE",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello!" }],
    },
    usage: {
      billed_units: {
        input_tokens: 10,
        output_tokens: 5,
      },
      tokens: {
        input_tokens: 10,
        output_tokens: 5,
      },
    },
  });
}

/**
 * Minimal Cohere /v2/chat streaming chunk shape.
 */
function cohereChatStreamChunkShape() {
  return extractShape({
    id: "chat-abc123",
    type: "content-delta",
    delta: {
      message: {
        content: { text: "Hel" },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Real API helpers
// ---------------------------------------------------------------------------

async function cohereChatNonStreaming(
  model: string,
  messages: { role: string; content: string }[],
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${COHERE_BASE_URL}/v2/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${COHERE_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      max_tokens: 10,
    }),
  });
  return { status: res.status, body: await res.text() };
}

async function cohereChatStreaming(
  model: string,
  messages: { role: string; content: string }[],
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${COHERE_BASE_URL}/v2/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${COHERE_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      max_tokens: 10,
    }),
  });
  return { status: res.status, body: await res.text() };
}

// ---------------------------------------------------------------------------
// Live chat-model resolution
// ---------------------------------------------------------------------------

/**
 * Outcome of resolving a live Cohere chat model:
 *   - { model }        → a valid, non-deprecated chat model to drive the leg
 *   - { infra }        → the listing call hit an auth/credit/rate-limit/5xx
 *                        condition; the caller SKIPS honestly (not drift)
 *   - { unavailable }  → the listing succeeded but exposed no usable chat
 *                        model (genuinely broken state — fail loud)
 */
type ResolvedModel = { model: string } | { infra: number } | { unavailable: true };

let cohereChatModelPromise: Promise<ResolvedModel> | null = null;

/**
 * Discover a currently-valid chat model from Cohere's own model listing rather
 * than hardcoding one. Cohere retires model IDs on a schedule (command-r-plus
 * was removed 2026-04-04, which is what quarantined this leg), so the listing
 * is the only drift-resilient source of a live model name.
 */
async function resolveCohereChatModel(): Promise<ResolvedModel> {
  const res = await fetch(`${COHERE_BASE_URL}/v1/models?endpoint=chat&page_size=1000`, {
    headers: { Authorization: `Bearer ${COHERE_API_KEY}` },
  });
  if (isInfraStatus(res.status)) return { infra: res.status };
  if (!res.ok) return { unavailable: true };
  const json = (await res.json()) as { models?: CohereModelEntry[] };
  const model = selectCohereChatModel(json.models ?? []);
  return model ? { model } : { unavailable: true };
}

/** Memoized so the whole live leg makes exactly one model-listing call. */
function getCohereChatModel(): Promise<ResolvedModel> {
  if (!cohereChatModelPromise) cohereChatModelPromise = resolveCohereChatModel();
  return cohereChatModelPromise;
}

// ---------------------------------------------------------------------------
// Error shape stubs
// ---------------------------------------------------------------------------

/**
 * Cohere error envelope shape returned by aimock for validation errors
 * and no-fixture-match scenarios.
 */
function cohereErrorShape() {
  return extractShape({
    error: {
      message: "Some error message",
      type: "invalid_request_error",
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Cohere error shapes", () => {
  it("malformed JSON returns 400 with error envelope", async () => {
    const res = await httpPostRaw(`${instance.url}/v2/chat`, "{not valid json");

    expect(res.status).toBe(400);

    const body = JSON.parse(res.body);
    const sdkShape = cohereErrorShape();
    const mockShape = extractShape(body);

    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("Cohere /v2/chat malformed JSON error", diffs, "cohere-chat");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("missing model field returns 400 with error envelope", async () => {
    const res = await httpPost(`${instance.url}/v2/chat`, {
      messages: [{ role: "user", content: "hello" }],
    });

    expect(res.status).toBe(400);

    const body = JSON.parse(res.body);
    const sdkShape = cohereErrorShape();
    const mockShape = extractShape(body);

    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport("Cohere /v2/chat missing model error", diffs, "cohere-chat");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("missing messages array returns 400 with error envelope", async () => {
    const res = await httpPost(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
    });

    expect(res.status).toBe(400);

    const body = JSON.parse(res.body);
    const sdkShape = cohereErrorShape();
    const mockShape = extractShape(body);

    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport(
      "Cohere /v2/chat missing messages error",
      diffs,
      "cohere-chat",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("no fixture match returns 404 with error envelope", async () => {
    const res = await httpPost(`${instance.url}/v2/chat`, {
      model: "command-r-plus",
      messages: [{ role: "user", content: "this will not match any fixture" }],
    });

    expect(res.status).toBe(404);

    const body = JSON.parse(res.body);
    const sdkShape = cohereErrorShape();
    const mockShape = extractShape(body);

    const diffs = triangulate(sdkShape, sdkShape, mockShape);
    const report = formatDriftReport(
      "Cohere /v2/chat no fixture match error",
      diffs,
      "cohere-chat",
    );

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});

describe.skipIf(!HAS_CREDENTIALS)("Cohere drift", () => {
  it("non-streaming /v2/chat shape matches", async (ctx) => {
    const resolved = await getCohereChatModel();
    if ("infra" in resolved) {
      // Provider-side auth/credit/rate-limit/5xx — honest skip, not drift.
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      throw new Error(
        "Cohere /v1/models?endpoint=chat exposed no usable non-deprecated chat model",
      );
    }
    const model = resolved.model;

    const sdkShape = cohereChatResponseShape();
    const messages = [{ role: "user", content: "Say hello" }];

    const [realRes, mockRes] = await Promise.all([
      cohereChatNonStreaming(model, messages),
      httpPost(`${instance.url}/v2/chat`, {
        model,
        messages,
        stream: false,
      }),
    ]);

    if (isInfraStatus(realRes.status)) {
      // Real API hit a transient provider-side condition — honest skip.
      ctx.skip();
      return;
    }

    expect(realRes.status).toBe(200);
    expect(mockRes.status).toBeLessThan(500);

    if (mockRes.status === 200) {
      const realShape = extractShape(JSON.parse(realRes.body));
      const mockShape = extractShape(JSON.parse(mockRes.body));

      const diffs = triangulate(sdkShape, realShape, mockShape);
      const report = formatDriftReport("Cohere /v2/chat (non-streaming)", diffs, "cohere-chat");

      expect(
        diffs.filter((d) => d.severity === "critical"),
        report,
      ).toEqual([]);
    }
  });

  it("streaming /v2/chat shape matches", async (ctx) => {
    const resolved = await getCohereChatModel();
    if ("infra" in resolved) {
      // Provider-side auth/credit/rate-limit/5xx — honest skip, not drift.
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      throw new Error(
        "Cohere /v1/models?endpoint=chat exposed no usable non-deprecated chat model",
      );
    }
    const model = resolved.model;

    const sdkChunkShape = cohereChatStreamChunkShape();
    const messages = [{ role: "user", content: "Say hello" }];

    const [realRes, mockRes] = await Promise.all([
      cohereChatStreaming(model, messages),
      httpPost(`${instance.url}/v2/chat`, {
        model,
        messages,
        stream: true,
      }),
    ]);

    if (isInfraStatus(realRes.status)) {
      // Real API hit a transient provider-side condition — honest skip.
      ctx.skip();
      return;
    }

    expect(realRes.status).toBe(200);
    expect(mockRes.status).toBeLessThan(500);

    if (mockRes.status === 200) {
      // Parse SSE chunks from both responses
      const realChunks = parseDataOnlySSE(realRes.body);
      const mockChunks = parseDataOnlySSE(mockRes.body);

      if (realChunks.length > 0 && mockChunks.length > 0) {
        // Compare first chunk shape (content-delta)
        const realChunkShape = extractShape(realChunks[0]);
        const mockChunkShape = extractShape(mockChunks[0]);

        const diffs = triangulate(sdkChunkShape, realChunkShape, mockChunkShape);
        const report = formatDriftReport(
          "Cohere /v2/chat (streaming first chunk)",
          diffs,
          "cohere-chat",
        );

        expect(
          diffs.filter((d) => d.severity === "critical"),
          report,
        ).toEqual([]);

        // Also compare the LAST chunk shape (has finish_reason, usage)
        const sdkLastChunkShape = extractShape({
          id: "chat-abc123",
          type: "message-end",
          delta: {
            finish_reason: "COMPLETE",
            usage: {
              billed_units: { input_tokens: 10, output_tokens: 5 },
              tokens: { input_tokens: 10, output_tokens: 5 },
            },
          },
        });

        const realLastShape = extractShape(realChunks[realChunks.length - 1]);
        const mockLastShape = extractShape(mockChunks[mockChunks.length - 1]);

        const lastDiffs = triangulate(sdkLastChunkShape, realLastShape, mockLastShape);
        const lastReport = formatDriftReport(
          "Cohere /v2/chat (streaming last chunk)",
          lastDiffs,
          "cohere-chat",
        );

        expect(
          lastDiffs.filter((d) => d.severity === "critical"),
          lastReport,
        ).toEqual([]);
      }
    }
  });
});
