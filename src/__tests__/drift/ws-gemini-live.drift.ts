/**
 * Gemini Live BidiGenerateContent WebSocket drift tests.
 *
 * Three-way comparison: SDK types × real API (WS) × aimock output (WS).
 *
 * Currently, the Gemini Live API only supports native-audio models (those
 * with "native-audio" in the name) which cannot return TEXT responses. Rather
 * than a hardcoded model pin + a human-maintained `.skip`/un-skip cycle, model
 * selection is SELF-HEALING: `fetchLiveCapableTextModels` + providers.ts's
 * shared `resolveLiveModel` (the R0 discovery helper, generalizing the cohere
 * #325 pattern) query the live model listing on every run and resolve to
 * exactly one of:
 *   - `{ model }`       — a text-capable bidiGenerateContent model exists NOW;
 *                         the drift tests below run for real against it.
 *   - `{ unavailable }` — today's real-world state (no such model yet) — an
 *                         HONEST SKIP, not a failure.
 *   - `{ infra }`       — the listing hit an auth/rate-limit/5xx condition —
 *                         also an honest skip (never a hard-fail).
 * A WS handshake-level infra status (401/403/429/5xx) is likewise an honest
 * skip via `WSHandshakeError` + `isInfraSkip` (ws-providers.ts, shared with
 * every other WS live leg). Only a genuine 2xx envelope-shape mismatch reports
 * drift — grading is on SHAPE (`compareSSESequences`), never on status codes.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { ServerInstance } from "../../server.js";
import { extractShape, compareSSESequences, formatDriftReport } from "./schema.js";
import {
  geminiLiveSetupCompleteShape,
  geminiLiveTextEventShapes,
  geminiLiveToolCallEventShapes,
} from "./sdk-shapes.js";
import { geminiLiveWS, WSHandshakeError } from "./ws-providers.js";
import {
  resolveLiveModel,
  isInfraSkip,
  __resetResolveLiveModelCache,
  type LiveModelEntry,
} from "./providers.js";
import {
  startDriftServer,
  stopDriftServer,
  collectMockWSMessages,
  classifyGeminiMessage,
  GEMINI_WS_PATH,
} from "./helpers.js";
import { connectWebSocket } from "../ws-test-client.js";

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

beforeAll(async () => {
  instance = await startDriftServer();
});

afterAll(async () => {
  await stopDriftServer(instance);
});

// ---------------------------------------------------------------------------
// Self-healing model discovery: find a text-capable bidiGenerateContent model
// ---------------------------------------------------------------------------

/**
 * Query the Gemini model listing API and normalize it to the `resolveLiveModel`
 * contract (R0's shared discovery helper), pre-filtered to models that support
 * `bidiGenerateContent` AND are NOT native-audio-only (the only kind that can
 * return TEXT responses over the Live WS protocol). A non-2xx status is
 * surfaced so `resolveLiveModel`/`isInfraSkip` can classify an auth/rate-limit/
 * 5xx listing failure as an honest skip rather than this function propagating
 * a bare fetch error.
 */
async function fetchLiveCapableTextModels(
  apiKey: string,
): Promise<{ status: number; models: LiveModelEntry[] }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return { status: res.status, models: [] };
  const data = (await res.json()) as {
    models?: { name: string; supportedGenerationMethods?: string[] }[];
  };
  const models: LiveModelEntry[] = (data.models ?? [])
    .filter(
      (m) =>
        m.supportedGenerationMethods?.includes("bidiGenerateContent") &&
        !m.name.includes("native-audio"),
    )
    .map((m) => ({ id: m.name.replace(/^models\//, "") }));
  return { status: res.status, models };
}

/**
 * Resolve the live text-capable Live model, memoized per the leg's cache key
 * so all tests in this file make exactly one listing call.
 */
function getLiveCapableTextModel(apiKey: string) {
  return resolveLiveModel("gemini-live-text", () => fetchLiveCapableTextModels(apiKey));
}

describe.skipIf(!GOOGLE_API_KEY)("Gemini Live WS drift", () => {
  const config = { apiKey: GOOGLE_API_KEY! };

  it("canary: text-capable bidiGenerateContent model availability", async () => {
    const resolved = await getLiveCapableTextModel(config.apiKey);
    if ("infra" in resolved) {
      console.warn(
        `[CANARY] Gemini model listing hit infra status ${resolved.infra} — cannot determine ` +
          `text-capable Live model availability this run.`,
      );
    } else if ("model" in resolved) {
      // A text-capable Live model now exists! The tests below discover and
      // drive it automatically — no manual un-skip/file-edit needed.
      console.warn(
        `[CANARY] Text-capable Gemini Live model found: ${resolved.model}. ` +
          `The drift tests below will now run for real against it.`,
      );
    }
    // This test always passes — it's a canary, not an assertion. When a model
    // appears (or the listing goes infra-unavailable), the console warning
    // signals what happened; the tests below self-heal either way.
    expect(true).toBe(true);
  });

  // These tests self-skip at runtime (via `ctx.skip()`) until a text-capable
  // model supports bidiGenerateContent, discovered dynamically above — no
  // hardcoded `.skip` and no manual file edit needed when Google adds one.

  it("WS text event sequence and shapes match", async (ctx) => {
    const resolved = await getLiveCapableTextModel(config.apiKey);
    if ("infra" in resolved) {
      console.warn(`[gemini-live drift] listing infra status ${resolved.infra} — skipping`);
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      console.warn(
        "[gemini-live drift] no text-capable bidiGenerateContent model available yet — skipping",
      );
      ctx.skip();
      return;
    }
    const model = `models/${resolved.model}`;

    const sdkEvents = [geminiLiveSetupCompleteShape(), ...geminiLiveTextEventShapes()];

    // Real API — a WS handshake-level infra status (auth/rate-limit/5xx) is an
    // HONEST SKIP, never a hard-fail that would quarantine the shared drift
    // baseline (mirrors ws-responses.drift.ts's handling of the same error type).
    let realResult;
    try {
      realResult = await geminiLiveWS(config, "Say hello", undefined, model);
    } catch (err) {
      if (err instanceof WSHandshakeError && isInfraSkip(err.status)) {
        console.warn(`[gemini-live drift] WS handshake infra status ${err.status} — skipping`);
        ctx.skip();
        return;
      }
      throw err;
    }

    // Mock — replicate Gemini Live protocol
    const mockWs = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    // Send setup — same discovered model as the real API call above, so both
    // sides of the 3-way comparison are driven identically.
    mockWs.send(
      JSON.stringify({
        setup: { model },
      }),
    );

    // Wait for setupComplete
    const setupMsgs = await mockWs.waitForMessages(1);
    const allMockRaw: unknown[] = [JSON.parse(setupMsgs[0])];

    // Send clientContent
    mockWs.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "Say hello" }] }],
          turnComplete: true,
        },
      }),
    );

    // Collect messages until turnComplete
    const contentMsgs = await collectMockWSMessages(
      mockWs,
      (msg) => {
        const m = msg as Record<string, unknown>;
        const sc = m.serverContent as Record<string, unknown> | undefined;
        return sc?.turnComplete === true;
      },
      15000,
      1, // skip the setupComplete message already consumed
    );
    allMockRaw.push(...contentMsgs.rawMessages);
    mockWs.close();

    // Build mock events with classified types
    const mockEvents = allMockRaw.map((msg) => ({
      type: classifyGeminiMessage(msg as Record<string, unknown>),
      dataShape: extractShape(msg),
    }));

    expect(realResult.rawMessages.length, "Real API returned no WS messages").toBeGreaterThan(0);
    expect(mockEvents.length, "Mock returned no WS messages").toBeGreaterThan(0);

    const diffs = compareSSESequences(sdkEvents, realResult.events, mockEvents);
    const report = formatDriftReport("Gemini Live WS (text events)", diffs, "gemini-live");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("WS tool call event sequence matches", async (ctx) => {
    const resolved = await getLiveCapableTextModel(config.apiKey);
    if ("infra" in resolved) {
      console.warn(`[gemini-live drift] listing infra status ${resolved.infra} — skipping`);
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      console.warn(
        "[gemini-live drift] no text-capable bidiGenerateContent model available yet — skipping",
      );
      ctx.skip();
      return;
    }
    const model = `models/${resolved.model}`;

    const sdkEvents = [geminiLiveSetupCompleteShape(), ...geminiLiveToolCallEventShapes()];

    const tools = [
      {
        functionDeclarations: [
          {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
      },
    ];

    // Real API — WS handshake-level infra status → honest skip (see the
    // first test above for the full rationale).
    let realResult;
    try {
      realResult = await geminiLiveWS(config, "Weather in Paris", tools, model);
    } catch (err) {
      if (err instanceof WSHandshakeError && isInfraSkip(err.status)) {
        console.warn(`[gemini-live drift] WS handshake infra status ${err.status} — skipping`);
        ctx.skip();
        return;
      }
      throw err;
    }

    // Mock — replicate Gemini Live protocol with tools
    const mockWs = await connectWebSocket(instance.url, GEMINI_WS_PATH);

    // Send setup with tools — same discovered model as the real API call above.
    mockWs.send(
      JSON.stringify({
        setup: { model, tools },
      }),
    );

    // Wait for setupComplete
    const setupMsgs = await mockWs.waitForMessages(1);
    const allMockRaw: unknown[] = [JSON.parse(setupMsgs[0])];

    // Send clientContent
    mockWs.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: "Weather in Paris" }] }],
          turnComplete: true,
        },
      }),
    );

    // Collect messages until toolCall
    const contentMsgs = await collectMockWSMessages(
      mockWs,
      (msg) => {
        const m = msg as Record<string, unknown>;
        return "toolCall" in m;
      },
      15000,
      1,
    );
    allMockRaw.push(...contentMsgs.rawMessages);
    mockWs.close();

    // Build mock events with classified types
    const mockEvents = allMockRaw.map((msg) => ({
      type: classifyGeminiMessage(msg as Record<string, unknown>),
      dataShape: extractShape(msg),
    }));

    expect(realResult.rawMessages.length, "Real API returned no WS messages").toBeGreaterThan(0);
    expect(mockEvents.length, "Mock returned no WS messages").toBeGreaterThan(0);

    const diffs = compareSSESequences(sdkEvents, realResult.events, mockEvents);
    const report = formatDriftReport("Gemini Live WS (tool call events)", diffs, "gemini-live");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Unit coverage for the self-healing resolution/skip logic (runs unconditionally
// — does NOT require GOOGLE_API_KEY, since the live describe block above is
// entirely gated out without one). Exercises the REAL functions the live leg
// calls (fetchLiveCapableTextModels + providers.ts's resolveLiveModel +
// ws-providers.ts's WSHandshakeError/isInfraSkip), stubbing only the network
// boundary (global fetch), so this is the fixture-driven red-green proof for
// an environment with no armed GOOGLE_API_KEY.
// ---------------------------------------------------------------------------

describe("Gemini Live model resolution (unit)", () => {
  const UNIT_CACHE_KEY = "gemini-live-text-unittest";

  afterEach(() => {
    __resetResolveLiveModelCache();
    vi.unstubAllGlobals();
  });

  it("classifies a 401 listing response as an honest infra skip", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 })),
    );
    const resolved = await resolveLiveModel(UNIT_CACHE_KEY, () =>
      fetchLiveCapableTextModels("fake-key"),
    );
    expect(resolved).toEqual({ infra: 401 });
  });

  it("classifies a 200 listing with no bidi text-capable model as unavailable (today's real state)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  name: "models/gemini-2.5-flash-native-audio-preview",
                  supportedGenerationMethods: ["bidiGenerateContent"],
                },
                {
                  name: "models/gemini-2.5-flash",
                  supportedGenerationMethods: ["generateContent"],
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const resolved = await resolveLiveModel(UNIT_CACHE_KEY, () =>
      fetchLiveCapableTextModels("fake-key"),
    );
    expect(resolved).toEqual({ unavailable: true });
  });

  it("discovers a text-capable bidiGenerateContent model when the provider adds one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  name: "models/gemini-2.5-flash-native-audio-preview",
                  supportedGenerationMethods: ["bidiGenerateContent"],
                },
                {
                  name: "models/gemini-live-text-preview",
                  supportedGenerationMethods: ["bidiGenerateContent"],
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const resolved = await resolveLiveModel(UNIT_CACHE_KEY, () =>
      fetchLiveCapableTextModels("fake-key"),
    );
    expect(resolved).toEqual({ model: "gemini-live-text-preview" });
  });

  it("classifies WS handshake auth/rate-limit/5xx statuses as an honest skip via isInfraSkip", () => {
    expect(isInfraSkip(new WSHandshakeError("unauthorized", 401).status)).toBe(true);
    expect(isInfraSkip(new WSHandshakeError("rate limited", 429).status)).toBe(true);
    expect(isInfraSkip(new WSHandshakeError("upstream outage", 503).status)).toBe(true);
    // A non-infra handshake status (e.g. a malformed-request 400) is NOT an
    // honest skip — it's a real problem the leg should still surface.
    expect(isInfraSkip(new WSHandshakeError("bad request", 400).status)).toBe(false);
  });
});
