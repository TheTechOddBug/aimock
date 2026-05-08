/**
 * Speech / TTS API drift tests (/v1/audio/speech).
 *
 * Unlike other drift tests that compare JSON shapes, the Speech API returns
 * raw binary audio with Content-Type headers. We validate:
 *   1. Content-Type matches the requested response_format
 *   2. Response body is non-empty binary data
 *   3. No JSON envelope wrapping the audio
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { ServerInstance } from "../../server.js";
import { createServer } from "../../server.js";
import type { Fixture } from "../../types.js";
import { stopDriftServer } from "./helpers.js";

// ---------------------------------------------------------------------------
// Audio fixture — base64-encoded minimal binary payload
// ---------------------------------------------------------------------------

// A small non-empty base64 blob simulating audio data.
const FAKE_AUDIO_B64 = Buffer.from("fake-audio-bytes-for-testing").toString("base64");

const SPEECH_FIXTURE: Fixture = {
  match: { userMessage: "Hello world" },
  response: { audio: FAKE_AUDIO_B64, format: "mp3" },
};

const SPEECH_OPUS_FIXTURE: Fixture = {
  match: { userMessage: "Opus test" },
  response: { audio: FAKE_AUDIO_B64, format: "opus" },
};

const SPEECH_AAC_FIXTURE: Fixture = {
  match: { userMessage: "AAC test" },
  response: { audio: FAKE_AUDIO_B64, format: "aac" },
};

const SPEECH_FLAC_FIXTURE: Fixture = {
  match: { userMessage: "FLAC test" },
  response: { audio: FAKE_AUDIO_B64, format: "flac" },
};

const SPEECH_WAV_FIXTURE: Fixture = {
  match: { userMessage: "WAV test" },
  response: { audio: FAKE_AUDIO_B64, format: "wav" },
};

// ---------------------------------------------------------------------------
// Raw binary HTTP helper — returns a Buffer instead of a decoded string
// ---------------------------------------------------------------------------

async function httpPostBinary(
  url: string,
  body: object,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let instance: ServerInstance;

beforeAll(async () => {
  instance = await createServer(
    [
      SPEECH_FIXTURE,
      SPEECH_OPUS_FIXTURE,
      SPEECH_AAC_FIXTURE,
      SPEECH_FLAC_FIXTURE,
      SPEECH_WAV_FIXTURE,
    ],
    { port: 0, chunkSize: 100 },
  );
});

afterAll(async () => {
  await stopDriftServer(instance);
});

// ---------------------------------------------------------------------------
// Format → expected Content-Type mapping
// ---------------------------------------------------------------------------

const FORMAT_EXPECTATIONS: Array<{
  format: string;
  expectedContentType: string;
  input: string;
}> = [
  { format: "mp3", expectedContentType: "audio/mpeg", input: "Hello world" },
  { format: "opus", expectedContentType: "audio/opus", input: "Opus test" },
  { format: "aac", expectedContentType: "audio/aac", input: "AAC test" },
  { format: "flac", expectedContentType: "audio/flac", input: "FLAC test" },
  { format: "wav", expectedContentType: "audio/wav", input: "WAV test" },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Speech/TTS API drift", () => {
  for (const { format, expectedContentType, input } of FORMAT_EXPECTATIONS) {
    it(`${format} response has correct Content-Type (${expectedContentType})`, async () => {
      const res = await httpPostBinary(`${instance.url}/v1/audio/speech`, {
        model: "tts-1",
        input,
        voice: "alloy",
        response_format: format,
      });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe(expectedContentType);
    });
  }

  it("response body is non-empty binary data", async () => {
    const res = await httpPostBinary(`${instance.url}/v1/audio/speech`, {
      model: "tts-1",
      input: "Hello world",
      voice: "alloy",
    });

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);

    // Verify the body matches the decoded base64 fixture
    const expected = Buffer.from(FAKE_AUDIO_B64, "base64");
    expect(res.body).toEqual(expected);
  });

  it("response body is NOT wrapped in a JSON envelope", async () => {
    const res = await httpPostBinary(`${instance.url}/v1/audio/speech`, {
      model: "tts-1",
      input: "Hello world",
      voice: "alloy",
    });

    expect(res.status).toBe(200);

    // The body should not be valid JSON — it is raw audio bytes
    const bodyStr = res.body.toString("utf-8");
    let isJson = false;
    try {
      JSON.parse(bodyStr);
      isJson = true;
    } catch {
      // Expected — raw binary is not JSON
    }
    expect(isJson, "Response body should be raw binary, not a JSON envelope").toBe(false);
  });

  it("missing input returns 400 error", async () => {
    const res = await httpPostBinary(`${instance.url}/v1/audio/speech`, {
      model: "tts-1",
      voice: "alloy",
    });

    expect(res.status).toBe(400);

    const body = JSON.parse(res.body.toString("utf-8"));
    expect(body.error.message).toContain("input");
  });

  it("malformed JSON returns 400 error", async () => {
    // Send raw invalid JSON directly
    const res = await new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
      body: Buffer;
    }>((resolve, reject) => {
      const req = http.request(
        `${instance.url}/v1/audio/speech`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () =>
            resolve({
              status: r.statusCode!,
              headers: r.headers,
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      req.on("error", reject);
      req.write("not valid json {{{");
      req.end();
    });

    expect(res.status).toBe(400);

    const body = JSON.parse(res.body.toString("utf-8"));
    expect(body.error.type).toBe("invalid_request_error");
  });
});
