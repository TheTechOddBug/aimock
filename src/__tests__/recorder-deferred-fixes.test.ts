import { describe, it, expect, vi } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FixtureFile, RecordProviderKey } from "../types.js";
import { proxyAndRecord } from "../recorder.js";
import { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function post(url: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Generic: drive a RAW upstream that returns exactly `responseJson`, record
// through proxyAndRecord, and return the persisted fixture file (+ logger).
// This exercises the REAL recorder path (proxyAndRecord -> buildFixtureResponse
// -> persistFixture), not buildFixtureResponse in isolation.
// ---------------------------------------------------------------------------

async function recordRawUpstream(opts: {
  provider: RecordProviderKey;
  endpoint: string;
  requestBody: Record<string, unknown>;
  responseJson: unknown;
  prefix: string;
}): Promise<{ fixture: FixtureFile; logger: Logger; warnSpy: ReturnType<typeof vi.spyOn> }> {
  const { provider, endpoint, requestBody, responseJson, prefix } = opts;

  const upstream = http.createServer((_upReq, upRes) => {
    upRes.writeHead(200, { "Content-Type": "application/json" });
    upRes.end(JSON.stringify(responseJson));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upstreamPort = (upstream.address() as { port: number }).port;

  const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const logger = new Logger("warn");
  const warnSpy = vi.spyOn(logger, "warn");

  const recorderServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const rawBody = Buffer.concat(chunks).toString();
      await proxyAndRecord(
        req,
        res,
        JSON.parse(rawBody),
        provider,
        endpoint,
        [],
        {
          record: {
            providers: { [provider]: `http://127.0.0.1:${upstreamPort}` },
            fixturePath,
          },
          logger,
        },
        rawBody,
      );
    });
  });
  await new Promise<void>((resolve) => recorderServer.listen(0, "127.0.0.1", () => resolve()));
  const recorderPort = (recorderServer.address() as { port: number }).port;

  try {
    const resp = await post(`http://127.0.0.1:${recorderPort}${endpoint}`, requestBody);
    expect(resp.status).toBe(200);

    const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const fixture = JSON.parse(
      fs.readFileSync(path.join(fixturePath, files[0]), "utf-8"),
    ) as FixtureFile;
    return { fixture, logger, warnSpy };
  } finally {
    // NOTE: do not mockRestore() here — the caller still needs to inspect
    // warnSpy.mock.calls after this helper returns. The Logger instance is
    // local and discarded, so the spy needs no cleanup.
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await new Promise<void>((resolve) => recorderServer.close(() => resolve()));
    fs.rmSync(fixturePath, { recursive: true, force: true });
  }
}

type ToolCallResp = { toolCalls?: Array<{ name: string; arguments: unknown }> };

// ===========================================================================
// Fix 1: tool-call `arguments` must ALWAYS be a string ("{}" when missing)
// ===========================================================================

describe("recorder fix #1 — tool-call arguments coalesce to string", () => {
  it("Gemini functionCall with missing args persists arguments as a string", async () => {
    const { fixture } = await recordRawUpstream({
      provider: "gemini",
      endpoint: "/v1beta/models/gemini-pro:generateContent",
      requestBody: { contents: [{ role: "user", parts: [{ text: "weather?" }] }] },
      responseJson: {
        candidates: [
          {
            content: {
              parts: [
                // functionCall with NO `args` field at all
                { functionCall: { name: "get_weather" } },
              ],
            },
          },
        ],
      },
      prefix: "aimock-fix1-gemini-",
    });
    const resp = fixture.fixtures[0].response as ToolCallResp;
    expect(resp.toolCalls).toBeDefined();
    expect(resp.toolCalls).toHaveLength(1);
    // CONTRACT: arguments is always a string (types.ts ToolCall.arguments: string)
    expect(typeof resp.toolCalls![0].arguments).toBe("string");
    expect(resp.toolCalls![0].arguments).toBe("{}");
  });

  it("Cohere v2 message-level tool_call with no args/parameters persists arguments as a string", async () => {
    const { fixture } = await recordRawUpstream({
      provider: "cohere",
      endpoint: "/v2/chat",
      requestBody: { model: "command-r", messages: [{ role: "user", content: "weather?" }] },
      responseJson: {
        finish_reason: "tool_call",
        message: {
          content: [],
          // message-level tool_calls with a function carrying NO arguments
          tool_calls: [{ id: "tc1", type: "function", function: { name: "get_weather" } }],
        },
      },
      prefix: "aimock-fix1-cohere-",
    });
    const resp = fixture.fixtures[0].response as ToolCallResp;
    expect(resp.toolCalls).toBeDefined();
    expect(resp.toolCalls).toHaveLength(1);
    expect(typeof resp.toolCalls![0].arguments).toBe("string");
    expect(resp.toolCalls![0].arguments).toBe("{}");
  });

  it("Gemini Interactions function_call with missing arguments persists arguments as a string", async () => {
    const { fixture } = await recordRawUpstream({
      provider: "gemini",
      endpoint: "/v1beta/models/gemini-pro:generateContent",
      requestBody: { contents: [{ role: "user", parts: [{ text: "weather?" }] }] },
      responseJson: {
        id: "resp1",
        status: "completed",
        outputs: [{ type: "function_call", name: "get_weather", id: "fc1" }],
      },
      prefix: "aimock-fix1-gemini-interactions-",
    });
    const resp = fixture.fixtures[0].response as ToolCallResp;
    expect(resp.toolCalls).toBeDefined();
    expect(resp.toolCalls).toHaveLength(1);
    expect(typeof resp.toolCalls![0].arguments).toBe("string");
    expect(resp.toolCalls![0].arguments).toBe("{}");
  });

  it("Bedrock Converse toolUse with missing input persists arguments as a string", async () => {
    const { fixture } = await recordRawUpstream({
      provider: "bedrock",
      endpoint: "/model/anthropic.claude-3/converse",
      requestBody: { messages: [{ role: "user", content: [{ text: "weather?" }] }] },
      responseJson: {
        output: {
          message: {
            role: "assistant",
            content: [{ toolUse: { name: "get_weather", toolUseId: "tu1" } }],
          },
        },
      },
      prefix: "aimock-fix1-bedrock-",
    });
    const resp = fixture.fixtures[0].response as ToolCallResp;
    expect(resp.toolCalls).toBeDefined();
    expect(resp.toolCalls).toHaveLength(1);
    expect(typeof resp.toolCalls![0].arguments).toBe("string");
    expect(resp.toolCalls![0].arguments).toBe("{}");
  });
});

// ===========================================================================
// Fix 2: base64 embeddings decoded regardless of request `encoding_format`,
// and malformed base64 handled (not silently dropped to {embedding:[]})
// ===========================================================================

describe("recorder fix #2 — base64 embedding decode gating", () => {
  // Float32Array([0.1, 0.2, 0.3]) encoded to base64 (12 bytes, %4 == 0)
  const VALID_B64 = "zczMPc3MTD6amZk+";

  it("decodes a base64 embedding even when request did not echo encoding_format", async () => {
    const { fixture } = await recordRawUpstream({
      provider: "openai",
      endpoint: "/v1/embeddings",
      // NOTE: no encoding_format in the request
      requestBody: { model: "text-embedding-3-small", input: "hello world" },
      responseJson: { data: [{ embedding: VALID_B64 }] },
      prefix: "aimock-fix2-noecho-",
    });
    const resp = fixture.fixtures[0].response as { embedding?: number[]; error?: unknown };
    expect(resp.error).toBeUndefined();
    expect(resp.embedding).toBeDefined();
    expect(resp.embedding).toHaveLength(3);
    expect(resp.embedding![0]).toBeCloseTo(0.1, 5);
    expect(resp.embedding![1]).toBeCloseTo(0.2, 5);
    expect(resp.embedding![2]).toBeCloseTo(0.3, 5);
  });

  it("warns and does not silently emit a zero-dim embedding for malformed base64", async () => {
    // "AQIDBAU=" decodes to 5 bytes (byteLength % 4 !== 0)
    const MALFORMED_B64 = "AQIDBAU=";
    const { fixture, warnSpy } = await recordRawUpstream({
      provider: "openai",
      endpoint: "/v1/embeddings",
      requestBody: { model: "text-embedding-3-small", input: "hello world" },
      responseJson: { data: [{ embedding: MALFORMED_B64 }] },
      prefix: "aimock-fix2-malformed-",
    });
    // A malformed base64 embedding must be diagnosed (logged), not silently
    // collapsed into a valid-looking zero-dimension embedding fixture.
    const warned = warnSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === "string" && /embedding/i.test(a)),
    );
    expect(warned).toBe(true);
    const resp = fixture.fixtures[0].response as {
      embedding?: number[];
      error?: { message?: string; type?: string };
    };
    // CONTRACT: a malformed base64 embedding must NOT produce ANY embedding
    // field — not an empty array, and not a misleadingly-populated one. The
    // previous assertion (`not.toEqual([])`) passed trivially even when
    // `embedding` was `undefined`, so it never actually pinned this contract.
    expect(resp.embedding).toBeUndefined();
    // It must instead be recorded as a diagnosable error fixture.
    expect(resp.error).toBeDefined();
    expect(typeof resp.error!.message).toBe("string");
  });
});

// ===========================================================================
// Fix 3: OpenAI image `data` mapping must skip items lacking url + b64_json
// ===========================================================================

describe("recorder fix #3 — OpenAI image data multi-item mapping", () => {
  it("does not emit empty {} image entries for items lacking url and b64_json", async () => {
    const { fixture } = await recordRawUpstream({
      provider: "openai",
      endpoint: "/v1/images/generations",
      requestBody: { model: "dall-e-3", prompt: "a cat", n: 2 },
      responseJson: {
        created: 123,
        data: [
          { url: "https://example.com/a.png", revised_prompt: "a fluffy cat" },
          // second item lacks BOTH url and b64_json
          { revised_prompt: "discarded" },
        ],
      },
      prefix: "aimock-fix3-images-",
    });
    const resp = fixture.fixtures[0].response as {
      images?: Array<Record<string, unknown>>;
      image?: Record<string, unknown>;
    };
    const entries = resp.images ?? (resp.image ? [resp.image] : []);
    // No entry may be an empty object: every recorded image must carry a url or b64Json.
    for (const e of entries) {
      const hasMedia = "url" in e || "b64Json" in e;
      expect(hasMedia).toBe(true);
    }
    // The single valid item is preserved.
    expect(entries.some((e) => e.url === "https://example.com/a.png")).toBe(true);
  });
});

// ===========================================================================
// Fix 4: unknown upstream shape must log the raw body/shape for diagnosability
// ===========================================================================

describe("recorder fix #4 — unknown upstream shape logging", () => {
  it("logs a warning with the object shape when the upstream shape is unrecognized", async () => {
    const { fixture, warnSpy } = await recordRawUpstream({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      requestBody: { model: "gpt-4", messages: [{ role: "user", content: "hi" }] },
      // An object that matches NONE of the known provider shapes.
      responseJson: { weird_unknown_field: "value", another: 42 },
      prefix: "aimock-fix4-unknown-",
    });
    const resp = fixture.fixtures[0].response as { error?: { message?: string } };
    // Still becomes the generic error fixture...
    expect(resp.error).toBeDefined();
    // ...but now the unknown shape is logged for diagnosability.
    const warned = warnSpy.mock.calls.some((args) =>
      args.some(
        (a) =>
          typeof a === "string" &&
          (/unknown|unrecognized|could not detect/i.test(a) || a.includes("weird_unknown_field")),
      ),
    );
    expect(warned).toBe(true);
  });
});
