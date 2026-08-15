/**
 * Shared test helpers for drift detection test files.
 *
 * Provides httpPost, SSE parsers (for mock server output), common
 * fixtures, and server lifecycle management used by all provider-specific
 * drift test files.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import http from "node:http";
import { createServer, type ServerInstance } from "../../server.js";
import type { Fixture } from "../../types.js";
import type { WSTestClient } from "../ws-test-client.js";
import { extractShape, type SSEEventShape } from "./schema.js";

import { classifyGeminiMessage } from "./ws-providers.js";

export { classifyGeminiMessage };

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export async function httpPost(
  url: string,
  body: object,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
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

/** POST raw string body (bypasses JSON.stringify — useful for malformed JSON tests). */
export async function httpPostRaw(
  url: string,
  rawBody: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// SSE parsers
// ---------------------------------------------------------------------------

/** Parse data-only SSE blocks (OpenAI Chat Completions, Gemini). */
export function parseDataOnlySSE(body: string): object[] {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") && block.trim() !== "data: [DONE]")
    .map((block) => {
      // Rejoin continuation lines (data split across multiple lines)
      const json = block
        .split("\n")
        .map((line) => (line.startsWith("data: ") ? line.slice(6) : line))
        .join("");
      return JSON.parse(json);
    });
}

/** Parse typed SSE blocks with event: + data: (Anthropic, OpenAI Responses). */
export function parseTypedSSE(body: string): { type: string; data: Record<string, any> }[] {
  return body
    .split("\n\n")
    .filter((block) => block.includes("event: ") && block.includes("data: "))
    .map((block) => {
      const eventMatch = block.match(/^event: (.+)$/m);
      const dataMatch = block.match(/^data: (.+)$/m);
      return {
        type: eventMatch![1],
        data: JSON.parse(dataMatch![1]),
      };
    });
}

/**
 * Parse data-only SSE blocks where the event_type is inside the JSON payload.
 * Used by the Gemini Interactions API which emits `data: {...}\n\n` with
 * `event_type` as a field in the JSON object.
 */
export function parseInteractionsSSE(
  body: string,
): { event_type: string; data: Record<string, any> }[] {
  return body
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") && !block.includes("[DONE]"))
    .map((block) => {
      const json = block.slice(6);
      const data = JSON.parse(json) as Record<string, any>;
      return {
        event_type: (data.event_type as string) ?? "unknown",
        data,
      };
    });
}

// ---------------------------------------------------------------------------
// Common fixtures
// ---------------------------------------------------------------------------

export const TEXT_FIXTURE: Fixture = {
  match: { userMessage: "Say hello" },
  response: { content: "Hello!" },
};

export const TOOL_FIXTURE: Fixture = {
  match: { userMessage: "Weather in Paris" },
  response: {
    toolCalls: [{ name: "get_weather", arguments: '{"city":"Paris"}' }],
  },
};

export const THINKING_FIXTURE: Fixture = {
  match: { userMessage: "Think about hello" },
  response: { content: "Hello!", reasoning: "I need to consider..." },
};

/**
 * Audio-out fixture for the Gemini Live drift leg.
 *
 * The Live API only supports the `AUDIO` response modality, so the mock side of
 * that leg's three-way comparison must be driven by an AUDIO fixture — a text
 * fixture would compare the mock's TEXT shape against a real AUDIO turn.
 *
 * `userMessage` matching is SUBSTRING (see router.ts), so this prompt must not
 * contain any other fixture's prompt: "Greet me aloud" shares no substring with
 * "Say hello" / "Weather in Paris" / "Think about hello", so the drift server's
 * other legs are unaffected.
 */
export const AUDIO_FIXTURE: Fixture = {
  match: { userMessage: "Greet me aloud" },
  response: { audio: { b64Json: "AAAAAA==", contentType: "audio/pcm;rate=24000" } },
};

/** The prompt that selects {@link AUDIO_FIXTURE} on both sides of a drift leg. */
export const AUDIO_PROMPT = "Greet me aloud";

/**
 * Tool-call fixture for the Gemini Live drift leg.
 *
 * A Live session carries exactly ONE response modality and it is `AUDIO`, so a
 * turn in which the model calls a function is an AUDIO turn that ALSO calls it:
 * the model speaks (`serverContent`) and then asks for the call (`toolCall`).
 * The shared {@link TOOL_FIXTURE} describes a text-protocol tool turn — tool
 * call and nothing else — so driving the Live leg's mock side with it produces
 * a bare `toolCall` with no model turn at all.
 *
 * That mis-drive is what run 31896605497's head report recorded as
 * `SSE:serverContent … mock:"<absent>"`, and the ORDER in it is not a guess: the
 * probe collects up to and including the FIRST `toolCall`, the real leg's
 * `toolCallCount > 0` assertion passed, and a `serverContent` was nonetheless
 * present in what it collected — so the provider sent `serverContent` strictly
 * BEFORE the `toolCall`. It is the same class of error as the TEXT-modality
 * request that mis-drove the REAL side: one side driven into a shape the
 * session's modality cannot produce.
 *
 * NOT PROVEN: the fields of the provider's pre-`toolCall` `serverContent`. The
 * artifact records the event TYPE only. `AUDIO` being the session's sole
 * modality, audio parts are the shape reproduced here; confirming the
 * provider's exact fields needs a live run.
 */
export const LIVE_TOOL_FIXTURE: Fixture = {
  match: { userMessage: "Weather in Paris" },
  response: {
    audio: { b64Json: "AAAAAA==", contentType: "audio/pcm;rate=24000" },
    toolCalls: [{ name: "get_weather", arguments: '{"city":"Paris"}' }],
  },
};

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export async function startDriftServer(): Promise<ServerInstance> {
  return createServer([TEXT_FIXTURE, TOOL_FIXTURE, THINKING_FIXTURE, AUDIO_FIXTURE], {
    port: 0,
    chunkSize: 100,
  });
}

/**
 * Drift server for the Gemini Live legs.
 *
 * Separate from {@link startDriftServer} because the Live leg's fixtures are
 * modality-specific: {@link LIVE_TOOL_FIXTURE} answers the same
 * `"Weather in Paris"` prompt as the shared {@link TOOL_FIXTURE} but with the
 * AUDIO turn a Live session actually produces. Putting it on the shared server
 * would mean either shadowing `TOOL_FIXTURE` for every other provider's tool
 * leg or gating it on a model-name pattern — and a Live model is not
 * identifiable by its name (see the header of ws-gemini-live.drift.ts). A
 * dedicated instance needs neither.
 */
export async function startGeminiLiveDriftServer(): Promise<ServerInstance> {
  return createServer([AUDIO_FIXTURE, LIVE_TOOL_FIXTURE], { port: 0, chunkSize: 100 });
}

export async function stopDriftServer(instance: ServerInstance): Promise<void> {
  await new Promise<void>((r) => instance.server.close(() => r()));
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

export const GEMINI_WS_PATH =
  "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/**
 * Collect mock WS messages until a terminal predicate fires.
 *
 * Uses a polling loop on waitForMessages() since ws-test-client doesn't
 * support predicate-based collection. The `skip` parameter tells us how
 * many messages have already been consumed so we don't re-read them.
 *
 * Throws if the terminal predicate never fires before the timeout expires.
 */
export async function collectMockWSMessages(
  client: WSTestClient,
  terminal: (msg: unknown) => boolean,
  timeoutMs = 15000,
  skip = 0,
): Promise<{ events: SSEEventShape[]; rawMessages: unknown[] }> {
  const rawMessages: unknown[] = [];
  const deadline = Date.now() + timeoutMs;
  let count = skip;
  let terminated = false;

  while (Date.now() < deadline) {
    const nextCount = count + 1;
    let msgs: string[];
    try {
      msgs = await client.waitForMessages(nextCount, Math.min(2000, deadline - Date.now()));
    } catch (e: unknown) {
      // Only suppress waitForMessages timeout — rethrow anything else
      if (e instanceof Error && e.message.includes("Timeout waiting for")) {
        if (Date.now() >= deadline) break;
        continue;
      }
      throw e;
    }
    // Only increment count after successful receipt
    count = nextCount;
    const latest = msgs[count - 1];
    let parsed: unknown;
    try {
      parsed = typeof latest === "string" ? JSON.parse(latest) : latest;
    } catch {
      throw new Error(
        `collectMockWSMessages: failed to parse message ${count}: ${String(latest).slice(0, 200)}`,
      );
    }
    rawMessages.push(parsed);
    if (terminal(parsed)) {
      terminated = true;
      break;
    }
  }

  if (!terminated) {
    throw new Error(
      `collectMockWSMessages timed out after ${timeoutMs}ms without terminal message. ` +
        `Collected ${rawMessages.length} messages.`,
    );
  }

  const events: SSEEventShape[] = rawMessages.map((msg) => {
    const m = msg as Record<string, any>;
    const type = m.type ?? classifyGeminiMessage(m as Record<string, unknown>);
    return { type, dataShape: extractShape(msg) };
  });

  return { events, rawMessages };
}
