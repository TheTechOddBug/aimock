import { describe, it, expect, vi } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FixtureFile, RecordProviderKey } from "../types.js";
import { proxyAndRecord, persistFixture, pickContentType } from "../recorder.js";
import { slugifyTestId } from "../helpers.js";
import { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// HTTP helper — collect status + body + headers.
// ---------------------------------------------------------------------------
function post(
  url: string,
  body: unknown,
  opts?: { onDisconnect?: (req: http.ClientRequest) => void },
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
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
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
        res.on("error", reject);
        if (opts?.onDisconnect) opts.onDisconnect(req);
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Generic JSON-upstream recorder driver (mirrors recorder-deferred-fixes).
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
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await new Promise<void>((resolve) => recorderServer.close(() => resolve()));
    fs.rmSync(fixturePath, { recursive: true, force: true });
  }
}

// ===========================================================================
// Finding 3 — Gemini audio filter must key on inlineData.data presence,
// not mimeType. Audio data with a missing/unexpected mimeType must still be
// captured into b64Json.
// ===========================================================================
describe("fid2 finding 3 — Gemini audio filter keys on inlineData.data", () => {
  it("captures audio b64Json when inlineData.data present but mimeType is missing", async () => {
    const { fixture } = await recordRawUpstream({
      provider: "gemini",
      endpoint: "/v1beta/models/gemini-pro:generateContent",
      requestBody: { contents: [{ role: "user", parts: [{ text: "say hi" }] }] },
      responseJson: {
        candidates: [
          {
            content: {
              // inlineData has data but NO mimeType field
              parts: [{ inlineData: { data: "QUJDREVG" } }],
            },
          },
        ],
      },
      prefix: "aimock-fid2-f3-",
    });
    const resp = fixture.fixtures[0].response as {
      audio?: { b64Json?: string; contentType?: string };
    };
    expect(resp.audio).toBeDefined();
    expect(resp.audio!.b64Json).toBe("QUJDREVG");
  });
});

// ===========================================================================
// Finding 4 — OpenAI non-streaming reasoning: read message.reasoning
// (DeepSeek/OpenRouter) in addition to reasoning_content.
// ===========================================================================
describe("fid2 finding 4 — OpenAI reasoning reads message.reasoning", () => {
  it("captures message.reasoning when reasoning_content is absent", async () => {
    const { fixture } = await recordRawUpstream({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      requestBody: { model: "deepseek-reasoner", messages: [{ role: "user", content: "2+2?" }] },
      responseJson: {
        choices: [
          {
            message: {
              content: "4",
              // DeepSeek/OpenRouter use `reasoning`, not `reasoning_content`
              reasoning: "Let me add 2 and 2.",
            },
          },
        ],
      },
      prefix: "aimock-fid2-f4-",
    });
    const resp = fixture.fixtures[0].response as { content?: string; reasoning?: string };
    expect(resp.content).toBe("4");
    expect(resp.reasoning).toBe("Let me add 2 and 2.");
  });
});

// ===========================================================================
// Finding 5 — Cohere v2: capture ALL text blocks (not just first), and
// route correctly even though it shares `message` with Ollama.
// ===========================================================================
describe("fid2 finding 5 — Cohere v2 multi-block + routing", () => {
  it("captures and joins ALL text blocks, not just the first", async () => {
    const { fixture } = await recordRawUpstream({
      provider: "cohere",
      endpoint: "/v2/chat",
      requestBody: { model: "command-r", messages: [{ role: "user", content: "hi" }] },
      responseJson: {
        finish_reason: "complete",
        message: {
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world" },
          ],
        },
      },
      prefix: "aimock-fid2-f5-multi-",
    });
    const resp = fixture.fixtures[0].response as { content?: string };
    expect(resp.content).toBe("Hello world");
  });

  it("does not mis-route a Cohere empty-content response to the Ollama path", async () => {
    // Cohere v2 with empty text content + no tool calls. The Cohere branch must
    // own this turn and produce a recognized (content:"") fixture, NOT fall
    // through to Ollama which would re-handle `message.content` array.
    const { fixture } = await recordRawUpstream({
      provider: "cohere",
      endpoint: "/v2/chat",
      requestBody: { model: "command-r", messages: [{ role: "user", content: "hi" }] },
      responseJson: {
        finish_reason: "complete",
        message: { content: [{ type: "text", text: "" }] },
      },
      prefix: "aimock-fid2-f5-empty-",
    });
    const resp = fixture.fixtures[0].response as { content?: string; error?: unknown };
    expect(resp.error).toBeUndefined();
    expect(resp.content).toBe("");
  });
});

// ===========================================================================
// Finding 9 — Transcription detector too loose. A non-transcription chat-ish
// response that merely has a string `text` + a `duration`-like field must NOT
// be misclassified as a transcription.
// ===========================================================================
describe("fid2 finding 9 — transcription detector tightened", () => {
  it("does not misclassify a non-transcription response as transcription", async () => {
    // No `task: transcribe`, no language; only an incidental `duration` number
    // alongside a `text` string, plus a clearly-chat marker (`object`).
    const { fixture } = await recordRawUpstream({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      requestBody: { model: "gpt-4", messages: [{ role: "user", content: "hi" }] },
      responseJson: {
        object: "some.event",
        text: "incidental text field",
        duration: 12,
      },
      prefix: "aimock-fid2-f9-",
    });
    const resp = fixture.fixtures[0].response as { transcription?: unknown };
    expect(resp.transcription).toBeUndefined();
  });

  it("still classifies a genuine transcription (task=transcribe)", async () => {
    const { fixture } = await recordRawUpstream({
      provider: "openai",
      endpoint: "/v1/audio/transcriptions",
      requestBody: { model: "whisper-1" },
      responseJson: { task: "transcribe", text: "hello there", language: "english" },
      prefix: "aimock-fid2-f9-ok-",
    });
    const resp = fixture.fixtures[0].response as { transcription?: { text?: string } };
    expect(resp.transcription).toBeDefined();
    expect(resp.transcription!.text).toBe("hello there");
  });
});

// ===========================================================================
// Finding 10 — Image batch: an empty-string b64_json item must not silently
// vanish, and an all-empty batch must log a warning on fallthrough.
// ===========================================================================
describe("fid2 finding 10 — image batch empty-string handling", () => {
  it("logs a warning when items are dropped from an image batch (empty-string b64_json)", async () => {
    // A batch where one item carries valid media and another carries an
    // empty-string b64_json. The empty item is dropped from the persisted
    // fixture; that drop must be logged (silent fidelity loss otherwise).
    const { warnSpy, fixture } = await recordRawUpstream({
      provider: "openai",
      endpoint: "/v1/images/generations",
      requestBody: { model: "dall-e-3", prompt: "x" },
      responseJson: {
        created: 1,
        data: [{ b64_json: "VkFMSUQ=" }, { b64_json: "" }],
      },
      prefix: "aimock-fid2-f10-",
    });
    // The valid item is preserved.
    const resp = fixture.fixtures[0].response as {
      images?: Array<Record<string, unknown>>;
      image?: Record<string, unknown>;
    };
    const entries = resp.images ?? (resp.image ? [resp.image] : []);
    expect(entries.some((e) => e.b64Json === "VkFMSUQ=")).toBe(true);
    // The dropped empty item must be logged with a specific drop message
    // (NOT merely the incidental "proxying to .../images/..." URL log).
    const warned = warnSpy.mock.calls.some((args) =>
      args.some(
        (a) =>
          typeof a === "string" && /dropp(ed|ing)|skipp(ed|ing)|empty/i.test(a) && /image/i.test(a),
      ),
    );
    expect(warned).toBe(true);
  });
});

// ===========================================================================
// Finding 12 — Ollama /api/generate detection too broad. A response that has
// a `response` string and a `done`-like field but is clearly NOT Ollama must
// not be captured by the Ollama generate branch when other markers exist.
// (Tighten: require done to be a boolean, the Ollama contract.)
// ===========================================================================
describe("fid2 finding 12 — Ollama /api/generate detection narrowed", () => {
  it("does not capture a non-Ollama response whose `done` is not a boolean", async () => {
    const { fixture } = await recordRawUpstream({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      requestBody: { model: "gpt-4", messages: [{ role: "user", content: "hi" }] },
      // `response` string + `done` present but `done` is a string, not the
      // boolean Ollama always sends. Should NOT be treated as Ollama generate.
      responseJson: { response: "not ollama", done: "nope" },
      prefix: "aimock-fid2-f12-",
    });
    const resp = fixture.fixtures[0].response as { content?: string; error?: unknown };
    expect(resp.content).not.toBe("not ollama");
    expect(resp.error).toBeDefined();
  });

  it("still captures a genuine Ollama /api/generate response (done boolean)", async () => {
    const { fixture } = await recordRawUpstream({
      provider: "ollama",
      endpoint: "/api/generate",
      requestBody: { model: "llama3", prompt: "hi" },
      responseJson: { response: "hello from ollama", done: true },
      prefix: "aimock-fid2-f12-ok-",
    });
    const resp = fixture.fixtures[0].response as { content?: string };
    expect(resp.content).toBe("hello from ollama");
  });
});

// ===========================================================================
// Finding 1 — Mid-stream upstream error during streaming relay must be
// surfaced, not delivered as a silent truncated 200.
// ===========================================================================
describe("fid2 finding 1 — mid-stream upstream error surfaced", () => {
  it("does not persist a truncated fixture when the upstream stream errors mid-flight", async () => {
    // Upstream sends SSE headers + one frame, then destroys the socket
    // abruptly (simulating a mid-stream network failure).
    const upstream = http.createServer((_upReq, upRes) => {
      upRes.writeHead(200, { "Content-Type": "text/event-stream" });
      upRes.write('data: {"choices":[{"delta":{"content":"par"}}]}\n\n');
      // Abruptly destroy the underlying socket mid-stream.
      setTimeout(() => upRes.socket?.destroy(), 20);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (upstream.address() as { port: number }).port;

    const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-fid2-f1-"));
    const logger = new Logger("warn");

    const recorderServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const rawBody = Buffer.concat(chunks).toString();
        await proxyAndRecord(
          req,
          res,
          JSON.parse(rawBody),
          "openai",
          "/v1/chat/completions",
          [],
          {
            record: {
              providers: { openai: `http://127.0.0.1:${upstreamPort}` },
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
      // Drive a raw client so we can observe whether the relay terminates with
      // a clean EOF (silent truncation — bug) or an aborted connection (correct
      // surfacing of the upstream failure).
      const clientOutcome = await new Promise<"clean_end" | "aborted">((resolve) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: recorderPort,
            path: "/v1/chat/completions",
            method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          (res) => {
            let settled = false;
            res.on("data", () => {});
            res.on("end", () => {
              if (!settled) {
                settled = true;
                resolve("clean_end");
              }
            });
            res.on("aborted", () => {
              if (!settled) {
                settled = true;
                resolve("aborted");
              }
            });
            res.on("error", () => {
              if (!settled) {
                settled = true;
                resolve("aborted");
              }
            });
          },
        );
        req.on("error", () => resolve("aborted"));
        req.end(
          JSON.stringify({
            model: "gpt-4",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
          }),
        );
      });

      // A mid-stream upstream failure must be surfaced to the client as an
      // aborted connection, NOT a clean EOF that masquerades as a complete
      // (but truncated) 200 response.
      expect(clientOutcome).toBe("aborted");

      // And the truncated stream must NOT be persisted as a clean fixture.
      const files = fs.existsSync(fixturePath)
        ? fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"))
        : [];
      expect(files).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await new Promise<void>((resolve) => recorderServer.close(() => resolve()));
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Finding 7 — Array content-type must not be join(", ")-ed into a malformed
// Content-Type relayed to the client; pick the first.
// ===========================================================================
describe("fid2 finding 7 — array content-type resolved to a single value", () => {
  it("picks the first element of an array content-type rather than join(', ')-ing it", () => {
    // Node normally collapses duplicate Content-Type response headers to a
    // single string, but `http.IncomingHttpHeaders` types content-type as
    // string | string[], and constructed/proxied header objects CAN be arrays.
    // join(', ') yields a malformed `Content-Type: application/json, text/html`
    // header — pick the first instead.
    const result = pickContentType(["application/json", "text/html; charset=utf-8"]);
    expect(result).toBe("application/json");
    // Must NOT be the malformed comma-joined value.
    expect(result).not.toContain(", ");
  });

  it("passes a plain string through and tolerates undefined/empty arrays", () => {
    expect(pickContentType("text/event-stream")).toBe("text/event-stream");
    expect(pickContentType(undefined)).toBe("");
    expect(pickContentType([])).toBe("");
  });
});

// ===========================================================================
// Finding 8 — empty-body audio response must not become a proxy_error fixture.
// ===========================================================================
describe("fid2 finding 8 — empty-body audio handled as audio shape", () => {
  it("does not record an empty audio response as a proxy_error", async () => {
    const upstream = http.createServer((_upReq, upRes) => {
      upRes.writeHead(200, { "Content-Type": "audio/mpeg" });
      upRes.end(); // zero-length audio body
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-fid2-f8-"));
    const logger = new Logger("warn");

    const recorderServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const rawBody = Buffer.concat(chunks).toString();
        await proxyAndRecord(
          req,
          res,
          JSON.parse(rawBody),
          "openai",
          "/v1/audio/speech",
          [],
          {
            record: { providers: { openai: `http://127.0.0.1:${upstreamPort}` }, fixturePath },
            logger,
          },
          rawBody,
        );
      });
    });
    await new Promise<void>((resolve) => recorderServer.listen(0, "127.0.0.1", () => resolve()));
    const recorderPort = (recorderServer.address() as { port: number }).port;

    try {
      const resp = await post(`http://127.0.0.1:${recorderPort}/v1/audio/speech`, {
        model: "tts-1",
        input: "hi",
        voice: "alloy",
      });
      expect(resp.status).toBe(200);
      const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      const fixture = JSON.parse(
        fs.readFileSync(path.join(fixturePath, files[0]), "utf-8"),
      ) as FixtureFile;
      const r = fixture.fixtures[0].response as { error?: { type?: string }; audio?: unknown };
      // An empty audio body must NOT be classified as a proxy_error.
      expect(r.error?.type).not.toBe("proxy_error");
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await new Promise<void>((resolve) => recorderServer.close(() => resolve()));
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Finding 11 — `_warning` must not fragment a warning containing "; ".
// ===========================================================================
describe("fid2 finding 11 — _warning does not fragment on embedded '; '", () => {
  it("round-trips a snapshot merge without fragmenting an embedded-semicolon warning", async () => {
    // We exercise persistFixture indirectly: first capture an over-cap warning
    // into a snapshot file, then verify the structure round-trips. Since the
    // existing join("; ") + split("; ") fragments any warning text containing
    // "; ", we assert that a single logical warning survives as one element.
    const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-fid2-f11-"));
    const logger = new Logger("silent");
    const testId = "fid2-f11-snapshot";
    const warnA = "captured A; then B happened";
    const warnB = "second warning";
    try {
      // First write with a warning that itself contains "; ".
      persistFixture({
        record: { providers: {}, fixturePath },
        providerKey: "openai",
        testId,
        fixture: { match: { userMessage: "one" }, response: { content: "x" } },
        fixtures: [],
        warnings: [warnA],
        logger,
      });
      // Second write (snapshot merge) with a DISTINCT new warning — the prior
      // semicolon-bearing warning must be carried forward as ONE logical entry,
      // not fragmented into "captured A" + "then B happened" which would then
      // mingle with warnB.
      persistFixture({
        record: { providers: {}, fixturePath },
        providerKey: "openai",
        testId,
        fixture: { match: { userMessage: "two" }, response: { content: "y" } },
        fixtures: [],
        warnings: [warnB],
        logger,
      });
      const file = path.join(fixturePath, slugifyTestId(testId), "openai.json");
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
        _warning?: string;
        _warnings?: string[];
      };
      // The contract: each logical warning survives intact as its own element.
      // A join("; ")/split("; ") round-trip fragments warnA into two entries.
      const stored: string[] = Array.isArray(parsed._warnings)
        ? parsed._warnings
        : typeof parsed._warning === "string"
          ? parsed._warning.split("; ")
          : [];
      expect(stored).toContain(warnA);
      expect(stored).toContain(warnB);
      // The fragments must NOT appear as standalone entries.
      expect(stored).not.toContain("captured A");
      expect(stored).not.toContain("then B happened");
    } finally {
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Finding 6 — ttftMs must be based on request-send time, not headers-received
// time. An upstream that delays its headers (TTFB) before streaming the first
// frame must have that latency reflected in ttftMs.
// ===========================================================================
describe("fid2 finding 6 — ttftMs measured from request send", () => {
  it("includes pre-headers latency in ttftMs", async () => {
    const HEADER_DELAY_MS = 120;
    // Upstream waits HEADER_DELAY_MS before sending SSE headers + frames.
    const upstream = http.createServer((_upReq, upRes) => {
      setTimeout(() => {
        upRes.writeHead(200, { "Content-Type": "text/event-stream" });
        upRes.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
        setTimeout(() => {
          upRes.write('data: {"choices":[{"delta":{"content":"b"}}]}\n\n');
          upRes.write("data: [DONE]\n\n");
          upRes.end();
        }, 10);
      }, HEADER_DELAY_MS);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-fid2-f6-"));
    const logger = new Logger("silent");

    const recorderServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const rawBody = Buffer.concat(chunks).toString();
        await proxyAndRecord(
          req,
          res,
          JSON.parse(rawBody),
          "openai",
          "/v1/chat/completions",
          [],
          {
            record: { providers: { openai: `http://127.0.0.1:${upstreamPort}` }, fixturePath },
            logger,
          },
          rawBody,
        );
      });
    });
    await new Promise<void>((resolve) => recorderServer.listen(0, "127.0.0.1", () => resolve()));
    const recorderPort = (recorderServer.address() as { port: number }).port;

    try {
      const resp = await post(`http://127.0.0.1:${recorderPort}/v1/chat/completions`, {
        model: "gpt-4",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(resp.status).toBe(200);
      const files = fs.readdirSync(fixturePath).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      const fixture = JSON.parse(
        fs.readFileSync(path.join(fixturePath, files[0]), "utf-8"),
      ) as FixtureFile;
      const timings = (fixture.fixtures[0] as { recordedTimings?: { ttftMs?: number } })
        .recordedTimings;
      expect(timings).toBeDefined();
      // ttft must reflect the time-to-first-token from request send, which
      // includes the upstream's pre-headers latency. Computing it from
      // headers-received time would understate it to near-zero.
      expect(timings!.ttftMs!).toBeGreaterThanOrEqual(HEADER_DELAY_MS * 0.7);
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await new Promise<void>((resolve) => recorderServer.close(() => resolve()));
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Finding 2 — client disconnect mid-relay must not persist a fixture and must
// not leave corrupt/partial journal state.
// ===========================================================================
describe("fid2 finding 2 — client disconnect leaves no fixture", () => {
  it("persists no fixture when the client disconnects mid-stream", async () => {
    // Upstream streams slowly; client disconnects after the first frame.
    const upstream = http.createServer((_upReq, upRes) => {
      upRes.writeHead(200, { "Content-Type": "text/event-stream" });
      upRes.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
      const iv = setInterval(() => {
        if (!upRes.writableEnded) {
          try {
            upRes.write('data: {"choices":[{"delta":{"content":"y"}}]}\n\n');
          } catch {
            clearInterval(iv);
          }
        }
      }, 25);
      upRes.on("close", () => clearInterval(iv));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const fixturePath = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-fid2-f2-"));
    const logger = new Logger("silent");

    const recorderServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const rawBody = Buffer.concat(chunks).toString();
        await proxyAndRecord(
          req,
          res,
          JSON.parse(rawBody),
          "openai",
          "/v1/chat/completions",
          [],
          {
            record: { providers: { openai: `http://127.0.0.1:${upstreamPort}` }, fixturePath },
            logger,
          },
          rawBody,
        );
      });
    });
    await new Promise<void>((resolve) => recorderServer.listen(0, "127.0.0.1", () => resolve()));
    const recorderPort = (recorderServer.address() as { port: number }).port;

    try {
      await new Promise<void>((resolve) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: recorderPort,
            path: "/v1/chat/completions",
            method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          (res) => {
            res.once("data", () => {
              // Abruptly disconnect after the first frame.
              req.destroy();
              resolve();
            });
            res.on("error", () => resolve());
          },
        );
        req.on("error", () => resolve());
        req.end(
          JSON.stringify({
            model: "gpt-4",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
          }),
        );
      });

      // Give the recorder a moment to settle its end/close handlers.
      await new Promise<void>((resolve) => setTimeout(resolve, 120));

      // A client disconnect must NOT leave a persisted (truncated) fixture, and
      // there must be no leftover .tmp half-written journal file.
      const all = fs.existsSync(fixturePath) ? fs.readdirSync(fixturePath) : [];
      const jsons = all.filter((f) => f.endsWith(".json"));
      const tmps = all.filter((f) => f.includes(".tmp."));
      expect(jsons).toHaveLength(0);
      expect(tmps).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await new Promise<void>((resolve) => recorderServer.close(() => resolve()));
      fs.rmSync(fixturePath, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Finding 13 — dead encodingFormat param removed (pure cleanup). This pins the
// behavior the dead param never affected: base64 embeddings decode identically
// WITH and WITHOUT `encoding_format` echoed in the request body.
// ===========================================================================
describe("fid2 finding 13 — base64 embedding decode unaffected by encoding_format", () => {
  // Float32Array([0.1, 0.2, 0.3]) base64-encoded.
  const VALID_B64 = "zczMPc3MTD6amZk+";

  it("decodes identically whether or not encoding_format is echoed", async () => {
    const withEcho = await recordRawUpstream({
      provider: "openai",
      endpoint: "/v1/embeddings",
      requestBody: { model: "text-embedding-3-small", input: "x", encoding_format: "base64" },
      responseJson: { data: [{ embedding: VALID_B64 }] },
      prefix: "aimock-fid2-f13-echo-",
    });
    const withoutEcho = await recordRawUpstream({
      provider: "openai",
      endpoint: "/v1/embeddings",
      requestBody: { model: "text-embedding-3-small", input: "x" },
      responseJson: { data: [{ embedding: VALID_B64 }] },
      prefix: "aimock-fid2-f13-noecho-",
    });
    const a = withEcho.fixture.fixtures[0].response as { embedding?: number[] };
    const b = withoutEcho.fixture.fixtures[0].response as { embedding?: number[] };
    expect(a.embedding).toBeDefined();
    expect(b.embedding).toBeDefined();
    expect(a.embedding).toEqual(b.embedding);
    expect(a.embedding).toHaveLength(3);
    expect(a.embedding![0]).toBeCloseTo(0.1, 5);
  });
});
