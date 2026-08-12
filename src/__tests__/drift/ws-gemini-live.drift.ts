/**
 * Gemini Live BidiGenerateContent WebSocket drift tests.
 *
 * Three-way comparison: SDK types × real API (WS) × aimock output (WS).
 *
 * MODALITY. The Live API permits exactly ONE response modality per session, and
 * every model exposing `bidiGenerateContent` is a native-audio model that
 * supports only `AUDIO` — Google's own capabilities guide states the native
 * audio models "only support `AUDIO` response modality". A session requesting
 * `TEXT` is refused out-of-band with an RFC 6455 CLOSE frame, observed verbatim
 * from the live endpoint as
 *
 *   code=1007 reason="The requested combination of response modalities (TEXT)
 *   is not supported by the model. models/gemini-3.1-flash-live-preview"
 *
 * so this leg drives the AUDIO shape — the shape the model actually emits —
 * and grades the audio event sequence (`inlineData` parts + `turnComplete`)
 * plus the modality-independent `toolCall`. The TEXT shape is NOT expressible
 * against any live Live model; aimock's TEXT path stays covered mock-only by
 * ws-gemini-live.test.ts, without live triangulation.
 *
 * MODEL SELECTION is SELF-HEALING rather than a hardcoded pin plus a
 * human-maintained `.skip` cycle: `fetchLiveCapableModels` + providers.ts's
 * shared `resolveLiveModel` query the live model listing on every run and
 * resolve to exactly one of:
 *   - `{ model }`       — a `bidiGenerateContent` model exists; the drift tests
 *                         below run for real against it.
 *   - `{ unavailable }` — the listing exposes no Live-capable model at all —
 *                         an HONEST SKIP, not a failure.
 *   - `{ infra }`       — the listing hit an auth/rate-limit/5xx condition —
 *                         also an honest skip (never a hard-fail).
 *
 * Selection keys on the listing's declared `bidiGenerateContent` support ONLY.
 * It must never re-derive a capability from the model NAME: a `"native-audio"`
 * name-substring filter silently mis-classified `gemini-3.1-flash-live-preview`
 * — a native-audio model whose name lacks that substring — as text-capable, and
 * the probe then requested TEXT on it. Google names models freely; the listing
 * is the only authority.
 *
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
  geminiLiveAudioEventShapes,
  geminiLiveToolCallEventShapes,
} from "./sdk-shapes.js";
import {
  geminiLiveWS,
  summarizeGeminiLiveTurn,
  GEMINI_LIVE_RESPONSE_MODALITIES,
  WSHandshakeError,
} from "./ws-providers.js";
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
  AUDIO_PROMPT,
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
// Self-healing model discovery: find a bidiGenerateContent-capable model
// ---------------------------------------------------------------------------

/**
 * Query the Gemini model listing API and normalize it to the `resolveLiveModel`
 * contract (R0's shared discovery helper), filtered to models that declare
 * `bidiGenerateContent` support.
 *
 * That declared method is the ONLY selection criterion. No model-name heuristic
 * is applied: names carry no reliable capability signal (see this file's header
 * — a `"native-audio"` substring filter mis-classified a native-audio model as
 * text-capable because Google left that substring out of its name), and since
 * the leg drives the universally-supported AUDIO modality it needs no capability
 * inference beyond "speaks the Live protocol".
 *
 * A non-2xx status is surfaced so `resolveLiveModel`/`isInfraSkip` can classify
 * an auth/rate-limit/5xx listing failure as an honest skip rather than this
 * function propagating a bare fetch error.
 */
async function fetchLiveCapableModels(
  apiKey: string,
): Promise<{ status: number; models: LiveModelEntry[] }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return { status: res.status, models: [] };
  const data = (await res.json()) as {
    models?: { name: string; supportedGenerationMethods?: string[] }[];
  };
  const models: LiveModelEntry[] = (data.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("bidiGenerateContent"))
    .map((m) => ({ id: m.name.replace(/^models\//, "") }));
  return { status: res.status, models };
}

/**
 * Resolve the live Live-capable model, memoized per the leg's cache key so all
 * tests in this file make exactly one listing call.
 */
function getLiveCapableModel(apiKey: string) {
  return resolveLiveModel("gemini-live", () => fetchLiveCapableModels(apiKey));
}

describe.skipIf(!GOOGLE_API_KEY)("Gemini Live WS drift", () => {
  const config = { apiKey: GOOGLE_API_KEY! };

  // These tests self-skip at runtime (via `ctx.skip()`) only when the listing
  // exposes no `bidiGenerateContent` model at all, or is infra-unavailable —
  // discovered dynamically above, with no hardcoded `.skip` to maintain.
  //
  // There is deliberately NO always-passing availability canary here: a test
  // whose body is `expect(true).toBe(true)` cannot fail, so it reports health it
  // never checked. The console warnings on the skip paths below carry the same
  // signal, and the assertions that remain can all actually go red.

  it("WS audio event sequence and shapes match", async (ctx) => {
    const resolved = await getLiveCapableModel(config.apiKey);
    if ("infra" in resolved) {
      console.warn(`[gemini-live drift] listing infra status ${resolved.infra} — skipping`);
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      console.warn("[gemini-live drift] listing exposes no bidiGenerateContent model — skipping");
      ctx.skip();
      return;
    }
    const model = `models/${resolved.model}`;

    const sdkEvents = [geminiLiveSetupCompleteShape(), ...geminiLiveAudioEventShapes()];

    // Real API — a WS handshake-level infra status (auth/rate-limit/5xx) is an
    // HONEST SKIP, never a hard-fail that would quarantine the shared drift
    // baseline (mirrors ws-responses.drift.ts's handling of the same error type).
    let realResult;
    try {
      realResult = await geminiLiveWS(config, AUDIO_PROMPT, undefined, model);
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

    // Send setup — same discovered model AND the same response modality as the
    // real API call above, so both sides of the 3-way comparison are driven
    // identically. Omitting generationConfig here would compare a real AUDIO
    // turn against an unconstrained mock one.
    mockWs.send(
      JSON.stringify({
        setup: {
          model,
          generationConfig: { responseModalities: GEMINI_LIVE_RESPONSE_MODALITIES },
        },
      }),
    );

    // Wait for setupComplete
    const setupMsgs = await mockWs.waitForMessages(1);
    const allMockRaw: unknown[] = [JSON.parse(setupMsgs[0])];

    // Send clientContent
    mockWs.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: AUDIO_PROMPT }] }],
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

    // Observe the AUDIO turn on BOTH sides before grading shapes. `compareSSESequences`
    // only reports a field the SDK shape and the real API BOTH have and the mock
    // lacks, so on its own it would pass a run in which the provider sent nothing
    // recognisable as an audio turn — silence read as health. These assertions are
    // what make the leg observe the modality's actual event sequence.
    const realTurn = summarizeGeminiLiveTurn(realResult.rawMessages);
    expect(
      realTurn.setupCompleteCount,
      `Real API sent no setupComplete: ${JSON.stringify(realTurn)}`,
    ).toBe(1);
    expect(
      realTurn.audioPartCount,
      `Real API streamed no inlineData audio parts (AUDIO modality was requested): ${JSON.stringify(realTurn)}`,
    ).toBeGreaterThan(0);
    expect(
      realTurn.turnCompleteCount,
      `Real API never completed the turn: ${JSON.stringify(realTurn)}`,
    ).toBeGreaterThan(0);

    const mockTurn = summarizeGeminiLiveTurn(allMockRaw);
    expect(
      mockTurn.audioPartCount,
      `Mock streamed no inlineData audio parts: ${JSON.stringify(mockTurn)}`,
    ).toBeGreaterThan(0);
    expect(
      mockTurn.turnCompleteCount,
      `Mock never completed the turn: ${JSON.stringify(mockTurn)}`,
    ).toBeGreaterThan(0);

    const diffs = compareSSESequences(sdkEvents, realResult.events, mockEvents);
    const report = formatDriftReport("Gemini Live WS (audio events)", diffs, "gemini-live");

    expect(
      diffs.filter((d) => d.severity === "critical"),
      report,
    ).toEqual([]);
  });

  it("WS tool call event sequence matches", async (ctx) => {
    const resolved = await getLiveCapableModel(config.apiKey);
    if ("infra" in resolved) {
      console.warn(`[gemini-live drift] listing infra status ${resolved.infra} — skipping`);
      ctx.skip();
      return;
    }
    if ("unavailable" in resolved) {
      console.warn("[gemini-live drift] listing exposes no bidiGenerateContent model — skipping");
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

    // Send setup with tools — same discovered model and response modality as
    // the real API call above (a Live session has exactly one modality, and
    // `toolCall` is emitted identically under it).
    mockWs.send(
      JSON.stringify({
        setup: {
          model,
          tools,
          generationConfig: { responseModalities: GEMINI_LIVE_RESPONSE_MODALITIES },
        },
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

    // Observe the tool call on BOTH sides — not merely that bytes arrived. A run
    // where the provider answered in prose instead of calling the function would
    // otherwise grade clean, because `compareSSESequences` cannot fail on an
    // event type the real API simply stopped emitting.
    const realTurn = summarizeGeminiLiveTurn(realResult.rawMessages);
    expect(
      realTurn.setupCompleteCount,
      `Real API sent no setupComplete: ${JSON.stringify(realTurn)}`,
    ).toBe(1);
    expect(
      realTurn.toolCallCount,
      `Real API emitted no toolCall despite a functionDeclaration: ${JSON.stringify(realTurn)}`,
    ).toBeGreaterThan(0);

    const mockTurn = summarizeGeminiLiveTurn(allMockRaw);
    expect(
      mockTurn.toolCallCount,
      `Mock emitted no toolCall: ${JSON.stringify(mockTurn)}`,
    ).toBeGreaterThan(0);

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
// calls (fetchLiveCapableModels + providers.ts's resolveLiveModel +
// ws-providers.ts's WSHandshakeError/isInfraSkip), stubbing only the network
// boundary (global fetch), so this is the fixture-driven red-green proof for
// an environment with no armed GOOGLE_API_KEY.
// ---------------------------------------------------------------------------

describe("Gemini Live model resolution (unit)", () => {
  const UNIT_CACHE_KEY = "gemini-live-unittest";

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
      fetchLiveCapableModels("fake-key"),
    );
    expect(resolved).toEqual({ infra: 401 });
  });

  it("classifies a 200 listing with no bidiGenerateContent model at all as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  name: "models/gemini-2.5-flash",
                  supportedGenerationMethods: ["generateContent"],
                },
                {
                  name: "models/text-embedding-004",
                  supportedGenerationMethods: ["embedContent"],
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const resolved = await resolveLiveModel(UNIT_CACHE_KEY, () =>
      fetchLiveCapableModels("fake-key"),
    );
    expect(resolved).toEqual({ unavailable: true });
  });

  it("selects on declared bidiGenerateContent support, never on the model NAME", async () => {
    // REGRESSION. Selection used to additionally require that the name NOT
    // contain "native-audio", as a proxy for text-capability. Both models below
    // are native-audio models, so under that heuristic this listing resolved to
    // `{unavailable:true}` for the one that admits it in its name and silently
    // mis-classified `gemini-3.1-flash-live-preview` — whose name hides it — as
    // text-capable. Names are not a capability signal; the listing is.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  name: "models/gemini-2.5-flash-native-audio-preview-12-2025",
                  supportedGenerationMethods: ["bidiGenerateContent"],
                },
                {
                  name: "models/gemini-3.1-flash-live-preview",
                  supportedGenerationMethods: ["bidiGenerateContent"],
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const resolved = await resolveLiveModel(UNIT_CACHE_KEY, () =>
      fetchLiveCapableModels("fake-key"),
    );
    expect(resolved).toEqual({ model: "gemini-2.5-flash-native-audio-preview-12-2025" });
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
