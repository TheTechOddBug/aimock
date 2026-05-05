import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Fixture, FixtureFile } from "../types.js";
import { createServer, type ServerInstance } from "../server.js";
import { slugifyTestId } from "../helpers.js";

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function post(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
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
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let upstream: ServerInstance | undefined;
let recorder: ServerInstance | undefined;
let tmpDir: string | undefined;

afterEach(async () => {
  if (recorder) {
    await new Promise<void>((resolve) => recorder!.server.close(() => resolve()));
    recorder = undefined;
  }
  if (upstream) {
    await new Promise<void>((resolve) => upstream!.server.close(() => resolve()));
    upstream = undefined;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

// ---------------------------------------------------------------------------
// Helper: set up upstream (real API mock) + recording proxy
// ---------------------------------------------------------------------------

async function setupUpstreamAndRecorder(
  upstreamFixtures: Fixture[],
): Promise<{ upstreamUrl: string; recorderUrl: string; fixturePath: string }> {
  upstream = await createServer(upstreamFixtures, { port: 0 });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-snapshot-"));
  recorder = await createServer([], {
    port: 0,
    logLevel: "silent",
    record: { providers: { openai: upstream.url }, fixturePath: tmpDir },
  });
  return { upstreamUrl: upstream.url, recorderUrl: recorder.url, fixturePath: tmpDir };
}

// ---------------------------------------------------------------------------
// Unit tests — slugifyTestId
// ---------------------------------------------------------------------------

describe("slugifyTestId", () => {
  it("converts Playwright titlePath separator to double dash", () => {
    expect(slugifyTestId("agent chat › handles tool call")).toBe("agent-chat--handles-tool-call");
  });

  it("handles simple space-separated string", () => {
    expect(slugifyTestId("simple test")).toBe("simple-test");
  });

  it("replaces special characters with dashes", () => {
    // "Test with 'quotes' & specials!" →
    //   non-word → dash: "Test-with--quotes---specials-"
    //   3+ dashes → double: "Test-with--quotes--specials-"
    //   trim trailing: "Test-with--quotes--specials"
    //   lowercase: "test-with--quotes--specials"
    expect(slugifyTestId("Test with 'quotes' & specials!")).toBe("test-with--quotes--specials");
    const result = slugifyTestId("Test with 'quotes' & specials!");
    expect(result).not.toMatch(/^-/);
    expect(result).not.toMatch(/-$/);
  });

  it("collapses 3+ consecutive dashes to double dash", () => {
    expect(slugifyTestId("a---b")).toBe("a--b");
    expect(slugifyTestId("a----b")).toBe("a--b");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugifyTestId("-hello-")).toBe("hello");
    expect(slugifyTestId("---hello---")).toBe("hello");
  });

  it("lowercases the result", () => {
    expect(slugifyTestId("MyTest")).toBe("mytest");
    expect(slugifyTestId("UPPER CASE")).toBe("upper-case");
  });

  it("handles underscores (word chars) as-is", () => {
    expect(slugifyTestId("my_test_case")).toBe("my_test_case");
  });

  it("handles empty string", () => {
    expect(slugifyTestId("")).toBe("");
  });

  it("strips .spec.ts prefix from Playwright titlePath", () => {
    expect(slugifyTestId("my-app.spec.ts › greeting › handles tool call")).toBe(
      "greeting--handles-tool-call",
    );
  });

  it("strips .test.tsx prefix", () => {
    expect(slugifyTestId("components.test.tsx › Button › renders correctly")).toBe(
      "button--renders-correctly",
    );
  });

  it("strips .e2e.js prefix", () => {
    expect(slugifyTestId("flow.e2e.js › checkout")).toBe("checkout");
  });

  it("handles testId with no file extension prefix", () => {
    expect(slugifyTestId("greeting › handles tool call")).toBe("greeting--handles-tool-call");
  });

  it("treats ASCII > the same as Unicode ›", () => {
    expect(slugifyTestId("greeting > handles tool call")).toBe("greeting--handles-tool-call");
  });
});

// ---------------------------------------------------------------------------
// Integration tests — snapshot-style recording
// ---------------------------------------------------------------------------

describe("snapshot-style recording", () => {
  it("creates fixture in testId-based directory when X-Test-Id is present", async () => {
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "capital of France" },
        response: { content: "Paris is the capital of France." },
      },
    ]);

    // Use ASCII-safe testId for the integration test — Node http.request rejects
    // non-ASCII header values. The slugifyTestId unit tests above cover the full
    // Unicode "›" separator handling.
    await post(
      `${recorderUrl}/v1/chat/completions`,
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "What is the capital of France?" }],
      },
      { "x-test-id": "agent chat - handles tool call" },
    );

    const slugDir = path.join(fixturePath, "agent-chat--handles-tool-call");
    expect(fs.existsSync(slugDir)).toBe(true);
    expect(fs.existsSync(path.join(slugDir, "openai.json"))).toBe(true);

    const content = JSON.parse(
      fs.readFileSync(path.join(slugDir, "openai.json"), "utf-8"),
    ) as FixtureFile;
    expect(content.fixtures).toHaveLength(1);
    expect(content.fixtures[0].match.userMessage).toBe("What is the capital of France?");
  });

  it("merges multiple fixtures into the same file for the same testId", async () => {
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "capital of France" },
        response: { content: "Paris is the capital of France." },
      },
      {
        match: { userMessage: "capital of Germany" },
        response: { content: "Berlin is the capital of Germany." },
      },
    ]);

    const testId = "multi-turn test";

    // First request
    await post(
      `${recorderUrl}/v1/chat/completions`,
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "What is the capital of France?" }],
      },
      { "x-test-id": testId },
    );

    // Second request with same testId but different message
    await post(
      `${recorderUrl}/v1/chat/completions`,
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "What is the capital of Germany?" }],
      },
      { "x-test-id": testId },
    );

    const slugDir = path.join(fixturePath, "multi-turn-test");
    const content = JSON.parse(
      fs.readFileSync(path.join(slugDir, "openai.json"), "utf-8"),
    ) as FixtureFile;
    expect(content.fixtures).toHaveLength(2);
    expect(content.fixtures[0].match.userMessage).toBe("What is the capital of France?");
    expect(content.fixtures[1].match.userMessage).toBe("What is the capital of Germany?");
  });

  it("creates separate directories for different testIds", async () => {
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "capital of France" },
        response: { content: "Paris is the capital of France." },
      },
      {
        match: { userMessage: "capital of Germany" },
        response: { content: "Berlin is the capital of Germany." },
      },
    ]);

    await post(
      `${recorderUrl}/v1/chat/completions`,
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "What is the capital of France?" }],
      },
      { "x-test-id": "test-one" },
    );

    await post(
      `${recorderUrl}/v1/chat/completions`,
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "What is the capital of Germany?" }],
      },
      { "x-test-id": "test-two" },
    );

    expect(fs.existsSync(path.join(fixturePath, "test-one", "openai.json"))).toBe(true);
    expect(fs.existsSync(path.join(fixturePath, "test-two", "openai.json"))).toBe(true);
  });

  it("falls back to timestamp-based filename when no X-Test-Id is present", async () => {
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "capital of France" },
        response: { content: "Paris is the capital of France." },
      },
    ]);

    await post(`${recorderUrl}/v1/chat/completions`, {
      model: "gpt-4",
      messages: [{ role: "user", content: "What is the capital of France?" }],
    });

    // Should be in the root fixturePath with timestamp pattern, not in a subdirectory
    const files = fs.readdirSync(fixturePath);
    const timestampFiles = files.filter((f) => f.startsWith("openai-") && f.endsWith(".json"));
    expect(timestampFiles).toHaveLength(1);
  });

  it("appends to existing fixture file on re-run", async () => {
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "capital of France" },
        response: { content: "Paris is the capital of France." },
      },
    ]);

    const testId = "re-run-test";
    const slugDir = path.join(fixturePath, "re-run-test");
    fs.mkdirSync(slugDir, { recursive: true });

    // Write an existing fixture file manually
    const existingFixture = {
      fixtures: [
        {
          match: { userMessage: "What is 2+2?" },
          response: { content: "4" },
        },
      ],
    };
    fs.writeFileSync(
      path.join(slugDir, "openai.json"),
      JSON.stringify(existingFixture, null, 2),
      "utf-8",
    );

    // Record a new fixture with the same testId
    await post(
      `${recorderUrl}/v1/chat/completions`,
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "What is the capital of France?" }],
      },
      { "x-test-id": testId },
    );

    const content = JSON.parse(
      fs.readFileSync(path.join(slugDir, "openai.json"), "utf-8"),
    ) as FixtureFile;

    // Should have both the pre-existing fixture AND the newly recorded one
    expect(content.fixtures).toHaveLength(2);
    expect(content.fixtures[0].match.userMessage).toBe("What is 2+2?");
    expect(content.fixtures[1].match.userMessage).toBe("What is the capital of France?");
  });

  it("falls back to timestamp recording when slugified testId is empty", async () => {
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "capital of France" },
        response: { content: "Paris is the capital of France." },
      },
    ]);

    // "." slugifies to "" (all non-word chars become dashes, then trimmed)
    await post(
      `${recorderUrl}/v1/chat/completions`,
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "What is the capital of France?" }],
      },
      { "x-test-id": "." },
    );

    // Should NOT create a subdirectory — should fall back to timestamp-based
    // filename in the root fixturePath
    const entries = fs.readdirSync(fixturePath);
    const timestampFiles = entries.filter((f) => f.startsWith("openai-") && f.endsWith(".json"));
    expect(timestampFiles).toHaveLength(1);

    // No subdirectories should have been created
    const dirs = entries.filter((e) => fs.statSync(path.join(fixturePath, e)).isDirectory());
    expect(dirs).toHaveLength(0);
  });

  it("falls back to timestamp recording when testId is all dashes", async () => {
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "capital of France" },
        response: { content: "Paris is the capital of France." },
      },
    ]);

    // "---" slugifies to "" (dashes are trimmed from both ends)
    await post(
      `${recorderUrl}/v1/chat/completions`,
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "What is the capital of France?" }],
      },
      { "x-test-id": "---" },
    );

    const entries = fs.readdirSync(fixturePath);
    const timestampFiles = entries.filter((f) => f.startsWith("openai-") && f.endsWith(".json"));
    expect(timestampFiles).toHaveLength(1);

    const dirs = entries.filter((e) => fs.statSync(path.join(fixturePath, e)).isDirectory());
    expect(dirs).toHaveLength(0);
  });

  it("handles corrupted existing fixture file by overwriting", async () => {
    const { recorderUrl, fixturePath } = await setupUpstreamAndRecorder([
      {
        match: { userMessage: "capital of France" },
        response: { content: "Paris is the capital of France." },
      },
    ]);

    const testId = "corrupted-test";
    const slugDir = path.join(fixturePath, "corrupted-test");
    fs.mkdirSync(slugDir, { recursive: true });

    // Write a corrupted file
    fs.writeFileSync(path.join(slugDir, "openai.json"), "{ not valid json", "utf-8");

    await post(
      `${recorderUrl}/v1/chat/completions`,
      {
        model: "gpt-4",
        messages: [{ role: "user", content: "What is the capital of France?" }],
      },
      { "x-test-id": testId },
    );

    const content = JSON.parse(
      fs.readFileSync(path.join(slugDir, "openai.json"), "utf-8"),
    ) as FixtureFile;

    // Should have only the new fixture (corrupted file was overwritten)
    expect(content.fixtures).toHaveLength(1);
    expect(content.fixtures[0].match.userMessage).toBe("What is the capital of France?");
  });
});
