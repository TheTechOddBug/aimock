import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as http from "node:http";
import type { RecordProviderKey } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";

// ---------------------------------------------------------------------------
// This suite exercises the REAL forwarded-header surface: a fake upstream HTTP
// server records the auth headers aimock forwards to it on a fixture-miss
// passthrough (proxy-only). We assert on what the fake upstream actually saw —
// not on a mock of aimock's internals.
// ---------------------------------------------------------------------------

function post(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
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
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

interface FakeUpstream {
  server: http.Server;
  url: string;
  /** Auth-relevant headers observed on the most recent request. */
  last: () => http.IncomingHttpHeaders;
  requestCount: () => number;
}

/**
 * A fake upstream that records the headers it receives and returns a minimal
 * OpenAI-shaped chat completion so aimock's collapse/record path is happy.
 */
function createFakeUpstream(): Promise<FakeUpstream> {
  return new Promise((resolve) => {
    let seen: http.IncomingHttpHeaders = {};
    let count = 0;
    const server = http.createServer((req, res) => {
      count++;
      seen = req.headers;
      // Drain the request body before responding.
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-fake",
            object: "chat.completion",
            created: Date.now(),
            model: "gpt-4",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "hi" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        last: () => seen,
        requestCount: () => count,
      });
    });
  });
}

const DUMMY = "sk-aimock-dev-ci-only";
const REAL = "sk-real-test-123";

let upstream: FakeUpstream | undefined;
let recorder: ServerInstance | undefined;

afterEach(async () => {
  if (recorder) {
    await new Promise<void>((r) => recorder!.server.close(() => r()));
    recorder = undefined;
  }
  if (upstream) {
    await new Promise<void>((r) => upstream!.server.close(() => r()));
    upstream = undefined;
  }
});

/**
 * Stand up the fake upstream + an aimock proxy-only recorder pointed at it for a
 * single provider, optionally with a built-in key configured for that provider.
 */
async function setup(
  provider: RecordProviderKey,
  providerKey?: string,
): Promise<{ recorderUrl: string }> {
  upstream = await createFakeUpstream();
  recorder = await createServer([], {
    port: 0,
    record: {
      providers: { [provider]: upstream.url },
      providerKeys: providerKey ? { [provider]: providerKey } : undefined,
      proxyOnly: true,
    },
  });
  return { recorderUrl: recorder.url };
}

const CHAT_PATH = "/v1/chat/completions";
const CHAT_BODY = { model: "gpt-4", messages: [{ role: "user", content: "unmatched-miss" }] };

describe("applyProviderAuth — aimock owns the upstream key", () => {
  describe("OpenAI (bearer)", () => {
    it("RED baseline: with NO built-in key, a dummy caller key is forwarded verbatim", async () => {
      const { recorderUrl } = await setup("openai"); // feature OFF
      const res = await post(recorderUrl + CHAT_PATH, CHAT_BODY, {
        Authorization: `Bearer ${DUMMY}`,
      });
      expect(res.status).toBe(200);
      // Today's behavior (and case (a)): dummy forwarded unchanged.
      expect(upstream!.last().authorization).toBe(`Bearer ${DUMMY}`);
    });

    it("GREEN: built-in key set + caller sends dummy → aimock injects its own key", async () => {
      const { recorderUrl } = await setup("openai", REAL);
      const res = await post(recorderUrl + CHAT_PATH, CHAT_BODY, {
        Authorization: `Bearer ${DUMMY}`,
      });
      expect(res.status).toBe(200);
      expect(upstream!.last().authorization).toBe(`Bearer ${REAL}`);
    });

    it("case (b): built-in key set + caller sends a REAL key → caller overrides", async () => {
      const callerReal = "sk-caller-owns-this-999";
      const { recorderUrl } = await setup("openai", REAL);
      await post(recorderUrl + CHAT_PATH, CHAT_BODY, {
        Authorization: `Bearer ${callerReal}`,
      });
      expect(upstream!.last().authorization).toBe(`Bearer ${callerReal}`);
    });

    it("no caller credential + built-in key set → aimock injects its own key", async () => {
      const { recorderUrl } = await setup("openai", REAL);
      await post(recorderUrl + CHAT_PATH, CHAT_BODY);
      expect(upstream!.last().authorization).toBe(`Bearer ${REAL}`);
    });
  });

  describe("Anthropic (x-api-key)", () => {
    it("built-in key set + caller sends dummy → injects x-api-key", async () => {
      const { recorderUrl } = await setup("anthropic", REAL);
      await post(recorderUrl + "/v1/messages", CHAT_BODY, { "x-api-key": DUMMY });
      expect(upstream!.last()["x-api-key"]).toBe(REAL);
    });

    it("caller sends a real x-api-key → forwarded unchanged", async () => {
      const { recorderUrl } = await setup("anthropic", REAL);
      await post(recorderUrl + "/v1/messages", CHAT_BODY, { "x-api-key": "real-anthropic-key" });
      expect(upstream!.last()["x-api-key"]).toBe("real-anthropic-key");
    });
  });

  describe("Gemini (x-goog-api-key)", () => {
    it("built-in key set + caller sends dummy → injects x-goog-api-key", async () => {
      const { recorderUrl } = await setup("gemini", REAL);
      await post(recorderUrl + "/v1beta/models/gemini-pro:generateContent", CHAT_BODY, {
        "x-goog-api-key": DUMMY,
      });
      expect(upstream!.last()["x-goog-api-key"]).toBe(REAL);
    });
  });

  describe("Cohere (bearer, via /v2/chat)", () => {
    const COHERE_PATH = "/v2/chat";
    const COHERE_BODY = {
      model: "command-r",
      messages: [{ role: "user", content: "unmatched-miss" }],
    };

    it("built-in key set + caller sends dummy → injects Bearer", async () => {
      const { recorderUrl } = await setup("cohere", REAL);
      await post(recorderUrl + COHERE_PATH, COHERE_BODY, {
        Authorization: `Bearer ${DUMMY}`,
      });
      expect(upstream!.last().authorization).toBe(`Bearer ${REAL}`);
    });

    it("caller sends a real Bearer key → forwarded unchanged", async () => {
      const callerReal = "co-caller-real-abc";
      const { recorderUrl } = await setup("cohere", REAL);
      await post(recorderUrl + COHERE_PATH, COHERE_BODY, {
        Authorization: `Bearer ${callerReal}`,
      });
      expect(upstream!.last().authorization).toBe(`Bearer ${callerReal}`);
    });

    it("inert when no built-in key set → dummy forwarded verbatim", async () => {
      const { recorderUrl } = await setup("cohere"); // feature OFF
      await post(recorderUrl + COHERE_PATH, COHERE_BODY, {
        Authorization: `Bearer ${DUMMY}`,
      });
      expect(upstream!.last().authorization).toBe(`Bearer ${DUMMY}`);
    });
  });

  describe("Ollama (bearer, via /api/chat)", () => {
    const OLLAMA_PATH = "/api/chat";
    const OLLAMA_BODY = {
      model: "llama3",
      messages: [{ role: "user", content: "unmatched-miss" }],
    };

    it("built-in key set + caller sends dummy → injects Bearer", async () => {
      const { recorderUrl } = await setup("ollama", REAL);
      await post(recorderUrl + OLLAMA_PATH, OLLAMA_BODY, {
        Authorization: `Bearer ${DUMMY}`,
      });
      expect(upstream!.last().authorization).toBe(`Bearer ${REAL}`);
    });

    it("inert when no built-in key set → dummy forwarded verbatim", async () => {
      const { recorderUrl } = await setup("ollama"); // feature OFF
      await post(recorderUrl + OLLAMA_PATH, OLLAMA_BODY, {
        Authorization: `Bearer ${DUMMY}`,
      });
      expect(upstream!.last().authorization).toBe(`Bearer ${DUMMY}`);
    });
  });

  describe("Azure OpenAI (api-key, via /openai/deployments/{id}/chat/completions)", () => {
    const AZURE_PATH = "/openai/deployments/my-deploy/chat/completions";

    it("built-in key set + caller sends dummy → injects api-key", async () => {
      const { recorderUrl } = await setup("azure", REAL);
      await post(recorderUrl + AZURE_PATH, CHAT_BODY, { "api-key": DUMMY });
      expect(upstream!.last()["api-key"]).toBe(REAL);
    });

    it("caller sends a real api-key → forwarded unchanged", async () => {
      const callerReal = "azure-caller-real-xyz";
      const { recorderUrl } = await setup("azure", REAL);
      await post(recorderUrl + AZURE_PATH, CHAT_BODY, { "api-key": callerReal });
      expect(upstream!.last()["api-key"]).toBe(callerReal);
    });

    it("inert when no built-in key set → dummy forwarded verbatim", async () => {
      const { recorderUrl } = await setup("azure"); // feature OFF
      await post(recorderUrl + AZURE_PATH, CHAT_BODY, { "api-key": DUMMY });
      expect(upstream!.last()["api-key"]).toBe(DUMMY);
    });
  });

  describe("ElevenLabs (xi-api-key, via /v1/text-to-speech/{voice})", () => {
    const EL_PATH = "/v1/text-to-speech/voice-123";
    const EL_BODY = { text: "unmatched-miss speak this" };

    it("built-in key set + caller sends dummy → injects xi-api-key", async () => {
      const { recorderUrl } = await setup("elevenlabs", REAL);
      await post(recorderUrl + EL_PATH, EL_BODY, { "xi-api-key": DUMMY });
      expect(upstream!.last()["xi-api-key"]).toBe(REAL);
    });

    it("caller sends a real xi-api-key → forwarded unchanged", async () => {
      const callerReal = "el-caller-real-777";
      const { recorderUrl } = await setup("elevenlabs", REAL);
      await post(recorderUrl + EL_PATH, EL_BODY, { "xi-api-key": callerReal });
      expect(upstream!.last()["xi-api-key"]).toBe(callerReal);
    });

    it("inert when no built-in key set → dummy forwarded verbatim", async () => {
      const { recorderUrl } = await setup("elevenlabs"); // feature OFF
      await post(recorderUrl + EL_PATH, EL_BODY, { "xi-api-key": DUMMY });
      expect(upstream!.last()["xi-api-key"]).toBe(DUMMY);
    });
  });

  describe("fal.ai (Authorization: Key, via /fal/queue/submit)", () => {
    const FAL_PATH = "/fal/queue/submit/fal-ai/some-model";
    const FAL_BODY = { prompt: "unmatched-miss render this" };

    it("built-in key set + caller sends dummy → injects Authorization: Key", async () => {
      const { recorderUrl } = await setup("fal", REAL);
      await post(recorderUrl + FAL_PATH, FAL_BODY, {
        Authorization: `Key ${DUMMY}`,
      });
      expect(upstream!.last().authorization).toBe(`Key ${REAL}`);
    });

    it("caller sends a real Key credential → forwarded unchanged", async () => {
      const callerReal = "fal-caller-real-555";
      const { recorderUrl } = await setup("fal", REAL);
      await post(recorderUrl + FAL_PATH, FAL_BODY, {
        Authorization: `Key ${callerReal}`,
      });
      expect(upstream!.last().authorization).toBe(`Key ${callerReal}`);
    });

    it("inert when no built-in key set → dummy forwarded verbatim", async () => {
      const { recorderUrl } = await setup("fal"); // feature OFF
      await post(recorderUrl + FAL_PATH, FAL_BODY, {
        Authorization: `Key ${DUMMY}`,
      });
      expect(upstream!.last().authorization).toBe(`Key ${DUMMY}`);
    });
  });

  describe("fixture MATCH short-circuits injection", () => {
    it("a matched request never reaches the proxy, so no injection happens", async () => {
      upstream = await createFakeUpstream();
      // Serve a fixture that matches the request so proxyAndRecord never runs.
      recorder = await createServer(
        [
          {
            match: { userMessage: "matched-hit" },
            response: { content: "served from fixture" },
          },
        ],
        {
          port: 0,
          record: {
            providers: { openai: upstream.url },
            providerKeys: { openai: REAL },
            proxyOnly: true,
          },
        },
      );
      const res = await post(
        recorder.url + CHAT_PATH,
        { model: "gpt-4", messages: [{ role: "user", content: "matched-hit" }] },
        { Authorization: `Bearer ${DUMMY}` },
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain("served from fixture");
      // The fake upstream was never contacted → injection path never ran.
      expect(upstream!.requestCount()).toBe(0);
    });
  });
});

describe("readProviderKeysFromEnv", () => {
  const ALL_ENV_VARS = [
    "AIMOCK_PROVIDER_OPENAI_KEY",
    "AIMOCK_PROVIDER_ANTHROPIC_KEY",
    "AIMOCK_PROVIDER_GEMINI_KEY",
    "AIMOCK_PROVIDER_OPENROUTER_KEY",
    "AIMOCK_PROVIDER_COHERE_KEY",
    "AIMOCK_PROVIDER_GROK_KEY",
    "AIMOCK_PROVIDER_OLLAMA_KEY",
    "AIMOCK_PROVIDER_VEO_KEY",
    "AIMOCK_PROVIDER_AZURE_KEY",
    "AIMOCK_PROVIDER_ELEVENLABS_KEY",
    "AIMOCK_PROVIDER_FAL_KEY",
  ] as const;
  const saved = { ...process.env };
  beforeEach(() => {
    for (const name of ALL_ENV_VARS) delete process.env[name];
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("returns undefined when no provider key env vars are set", async () => {
    const { readProviderKeysFromEnv } = await import("../provider-auth.js");
    expect(readProviderKeysFromEnv({})).toBeUndefined();
  });

  it("reads every wired provider key from its env var", async () => {
    const { readProviderKeysFromEnv } = await import("../provider-auth.js");
    const keys = readProviderKeysFromEnv({
      AIMOCK_PROVIDER_OPENAI_KEY: "o",
      AIMOCK_PROVIDER_ANTHROPIC_KEY: "a",
      AIMOCK_PROVIDER_GEMINI_KEY: "g",
      AIMOCK_PROVIDER_OPENROUTER_KEY: "or",
      AIMOCK_PROVIDER_COHERE_KEY: "co",
      AIMOCK_PROVIDER_GROK_KEY: "gr",
      AIMOCK_PROVIDER_OLLAMA_KEY: "ol",
      AIMOCK_PROVIDER_VEO_KEY: "ve",
      AIMOCK_PROVIDER_AZURE_KEY: "az",
      AIMOCK_PROVIDER_ELEVENLABS_KEY: "el",
      AIMOCK_PROVIDER_FAL_KEY: "fa",
    } as NodeJS.ProcessEnv);
    expect(keys).toEqual({
      openai: "o",
      anthropic: "a",
      gemini: "g",
      openrouter: "or",
      cohere: "co",
      grok: "gr",
      ollama: "ol",
      veo: "ve",
      azure: "az",
      elevenlabs: "el",
      fal: "fa",
    });
  });

  it("treats an empty-string env var as unset (feature stays inert)", async () => {
    const { readProviderKeysFromEnv } = await import("../provider-auth.js");
    const keys = readProviderKeysFromEnv({
      AIMOCK_PROVIDER_OPENAI_KEY: "o",
      AIMOCK_PROVIDER_COHERE_KEY: "",
      AIMOCK_PROVIDER_FAL_KEY: "",
    } as NodeJS.ProcessEnv);
    expect(keys).toEqual({ openai: "o" });
  });
});
