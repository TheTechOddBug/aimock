/**
 * Regression + guard tests for the Responses WS live-leg self-healing retrofit
 * (R5, aligning ws-responses.drift.ts to the ws-realtime discovery/GA pattern
 * from #324).
 *
 * The old leg hardcoded `model: "gpt-4o-mini"` in both the real WS request AND
 * hardcoded the SAME literal in the mock request, and its terminal predicate
 * only recognized `response.completed`/`response.done` — a retired endpoint
 * (handshake auth/rate/5xx) surfaced as a bare, unclassified `Error`, and a
 * retired/invalid model id surfaced as an in-band `{"type":"error"}` frame the
 * old predicate never terminated on (so the leg would hang until the 30s
 * `waitUntil` timeout and then hard-fail/quarantine the batch instead of
 * skipping honestly).
 *
 * These tests drive the REAL exported ws-providers.ts surface (no local
 * reimplementation of the classification logic) so they exercise the actual
 * failure surface the live leg runs against, without requiring a live
 * OPENAI_API_KEY or a real TLS connection.
 *
 *   RED (pre-fix): these exports (`WSHandshakeError`, `parseHandshakeStatus`,
 *   `isResponsesWSTerminal`, `extractWSErrorBody`, `buildResponsesCreateMessage`,
 *   and `openaiResponsesWS`'s `model` parameter) did not exist — this file
 *   fails to even type-check/import against the pre-retrofit ws-providers.ts.
 *   GREEN (post-fix): the exports exist and classify each condition correctly.
 */
import { describe, it, expect } from "vitest";
import {
  WSHandshakeError,
  parseHandshakeStatus,
  isResponsesWSTerminal,
  extractWSErrorBody,
  buildResponsesCreateMessage,
} from "./ws-providers.js";
import { isInfraSkip, isModelNotFound } from "./providers.js";

describe("parseHandshakeStatus", () => {
  it("extracts the numeric status from a standard HTTP status line", () => {
    expect(parseHandshakeStatus("HTTP/1.1 401 Unauthorized")).toBe(401);
    expect(parseHandshakeStatus("HTTP/1.1 429 Too Many Requests")).toBe(429);
    expect(parseHandshakeStatus("HTTP/1.1 503 Service Unavailable")).toBe(503);
    expect(parseHandshakeStatus("HTTP/1.1 101 Switching Protocols")).toBe(101);
  });

  it("returns null for a malformed/unexpected status line", () => {
    expect(parseHandshakeStatus("garbage")).toBeNull();
    expect(parseHandshakeStatus("")).toBeNull();
  });
});

describe("REGRESSION: WS handshake failure classification (#R5)", () => {
  it("RED (old shape): a bare Error carries no status — cannot be classified as an honest skip", () => {
    // This is exactly what connectTLSWebSocket threw BEFORE the retrofit: an
    // unstructured Error with the status only embedded in prose. A caller has
    // no reliable field to feed isInfraSkip, so a 401/429/503 handshake
    // rejection could only be treated as a hard failure — the leg would
    // quarantine on any transient provider-side condition.
    const oldStyleError = new Error("WebSocket upgrade failed: HTTP/1.1 401 Unauthorized");
    expect(oldStyleError).not.toBeInstanceOf(WSHandshakeError);
    expect((oldStyleError as { status?: number }).status).toBeUndefined();
  });

  it("GREEN (new shape): WSHandshakeError carries a parsed status isInfraSkip can classify", () => {
    const err = new WSHandshakeError("WebSocket upgrade failed: HTTP/1.1 401 Unauthorized", 401);
    expect(err).toBeInstanceOf(WSHandshakeError);
    expect(err.status).toBe(401);
    expect(isInfraSkip(err.status)).toBe(true);
  });

  it("classifies the full infra-status set (401/402/403/429/5xx) as skippable", () => {
    for (const status of [401, 402, 403, 429, 500, 502, 503]) {
      const err = new WSHandshakeError(`WebSocket upgrade failed: HTTP/1.1 ${status}`, status);
      expect(isInfraSkip(err.status), `status ${status}`).toBe(true);
    }
  });

  it("GUARD: a genuine 4xx that is NOT an infra status is not swallowed as a skip", () => {
    // e.g. 400 Bad Request from a malformed handshake — a real bug, not a
    // provider-side outage. Must stay unclassified so it fails loud.
    const err = new WSHandshakeError("WebSocket upgrade failed: HTTP/1.1 400 Bad Request", 400);
    expect(isInfraSkip(err.status)).toBe(false);
  });
});

describe("REGRESSION: in-band model-not-found detection (#R5)", () => {
  const modelNotFoundFrame = {
    type: "error",
    error: { type: "invalid_request_error", code: "model_not_found", message: "model retired" },
  };
  const completionFrame = { type: "response.completed", response: { id: "resp_1" } };

  it("RED (old predicate): the old terminal predicate never recognizes an error frame", () => {
    // The exact predicate the pre-retrofit code used inline — copied here ONLY
    // to document the bug being fixed, not as the code under test.
    const oldTerminalPredicate = (msg: unknown) => {
      const m = msg as { type?: string } | null;
      return m?.type === "response.completed" || m?.type === "response.done";
    };
    // An error frame never satisfies the old predicate — waitUntil would spin
    // until the 30s timeout, then hard-fail with an unclassified timeout error
    // instead of an honest, fast skip.
    expect(oldTerminalPredicate(modelNotFoundFrame)).toBe(false);
  });

  it("GREEN (new predicate): isResponsesWSTerminal recognizes the error frame as terminal", () => {
    expect(isResponsesWSTerminal(modelNotFoundFrame)).toBe(true);
    expect(isResponsesWSTerminal(completionFrame)).toBe(true);
    expect(isResponsesWSTerminal({ type: "response.output_text.delta" })).toBe(false);
  });

  it("extractWSErrorBody surfaces the error frame body for isModelNotFound classification", () => {
    const body = extractWSErrorBody([completionFrame, modelNotFoundFrame]);
    expect(body).not.toBeNull();
    expect(isModelNotFound(400, body!)).toBe(true);
  });

  it("extractWSErrorBody returns null on a normal completion — no false-positive skip", () => {
    expect(extractWSErrorBody([completionFrame])).toBeNull();
  });

  it("GUARD: a genuine invalid_request_error unrelated to the model is NOT classified as model-not-found", () => {
    const unrelatedError = {
      type: "error",
      error: { type: "invalid_request_error", code: "invalid_json", message: "malformed input" },
    };
    const body = extractWSErrorBody([unrelatedError]);
    expect(body).not.toBeNull();
    expect(isModelNotFound(400, body!)).toBe(false);
  });
});

describe("REGRESSION: model is threaded, never hardcoded (#R5)", () => {
  it("buildResponsesCreateMessage reflects the caller-supplied (live-discovered) model", () => {
    const discovered = buildResponsesCreateMessage("gpt-4o-mini-2024-11-20", [
      { role: "user", content: "hi" },
    ]);
    expect(discovered.model).toBe("gpt-4o-mini-2024-11-20");
    expect(discovered.type).toBe("response.create");
  });

  it("includes tools only when provided", () => {
    const withTools = buildResponsesCreateMessage("gpt-4o-mini", [], [{ type: "function" }]);
    expect(withTools.tools).toEqual([{ type: "function" }]);
    const withoutTools = buildResponsesCreateMessage("gpt-4o-mini", []);
    expect(withoutTools.tools).toBeUndefined();
  });
});
