/**
 * Regression + guard tests for the discarded WebSocket CLOSE code.
 *
 * The bug: the drift WS client handled an incoming CLOSE frame with a bare
 * `socket.end()`, throwing away the frame's 2-byte status code and its reason
 * string. A provider REFUSING a session therefore produced the exact same
 * observation as a provider that accepted the socket and then said nothing —
 * both surfaced only as
 *
 *   Error: waitUntil timeout after 30000ms. Collected 0 messages: [] bodies=[]
 *
 * which is why a live Gemini Live failure of that shape could not be diagnosed.
 *
 *   RED (pre-fix): `parseCloseFrame`/`WSClosedError` did not exist, and the
 *   refusal case below was byte-for-byte identical to the silence case.
 *   GREEN (post-fix): the refusal reports code + reason; the silence case still
 *   reports a plain timeout.
 *
 * These tests drive the REAL exported `connectTLSWebSocket` path against a
 * local TLS server (no reimplementation of the client's framing) and use the
 * real server-side `computeAcceptKey` for the upgrade, so the transport,
 * handshake and frame parsing under test are the ones the live legs run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as tls from "node:tls";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { computeAcceptKey } from "../../ws-framing.js";
import { connectTLSWebSocket, parseCloseFrame, WSClosedError } from "./ws-providers.js";

// ---------------------------------------------------------------------------
// Local TLS WebSocket server
// ---------------------------------------------------------------------------

let certDir: string;
let key: Buffer;
let cert: Buffer;

beforeAll(() => {
  certDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-wsclose-"));
  const keyPath = path.join(certDir, "key.pem");
  const certPath = path.join(certDir, "cert.pem");
  // A throwaway self-signed cert, generated per-run so no private key is ever
  // committed. Node requires a subjectAltName (a CN alone is rejected).
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  key = fs.readFileSync(keyPath);
  cert = fs.readFileSync(certPath);
});

afterAll(() => {
  if (certDir) fs.rmSync(certDir, { recursive: true, force: true });
});

/** An unmasked server-to-client CLOSE frame (RFC 6455 §5.5.1). */
function serverCloseFrame(code?: number, reason = ""): Buffer {
  let payload = Buffer.alloc(0);
  if (code !== undefined) {
    const reasonBuf = Buffer.from(reason, "utf-8");
    payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
  }
  const header = Buffer.alloc(2);
  header[0] = 0x88; // FIN + CLOSE
  header[1] = payload.length;
  return Buffer.concat([header, payload]);
}

/** An unmasked server-to-client TEXT frame (payloads here are always < 126). */
function serverTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf-8");
  const header = Buffer.alloc(2);
  header[0] = 0x81; // FIN + TEXT
  header[1] = payload.length;
  return Buffer.concat([header, payload]);
}

interface LocalServer {
  port: number;
  stop: () => void;
}

/**
 * Stand up a TLS server that completes the WS upgrade and then hands the socket
 * to `afterUpgrade`, which decides how the "provider" behaves.
 */
function startServer(afterUpgrade: (socket: tls.TLSSocket) => void): Promise<LocalServer> {
  return new Promise((resolve) => {
    const live: tls.TLSSocket[] = [];
    const server = tls.createServer({ key, cert }, (socket) => {
      live.push(socket);
      socket.once("data", (data: Buffer) => {
        const wsKey = /sec-websocket-key:\s*(\S+)/i.exec(data.toString())?.[1] ?? "";
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${computeAcceptKey(wsKey)}\r\n\r\n`,
        );
        afterUpgrade(socket);
      });
      socket.on("error", () => {
        /* the client tears sockets down mid-flight; not a test failure */
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        stop: () => {
          for (const s of live) s.destroy();
          server.close();
        },
      });
    });
  });
}

/** Connect the real client to a local server, guaranteeing teardown. */
async function withClient<T>(
  afterUpgrade: (socket: tls.TLSSocket) => void,
  body: (ws: Awaited<ReturnType<typeof connectTLSWebSocket>>) => Promise<T>,
): Promise<T> {
  const server = await startServer(afterUpgrade);
  try {
    const ws = await connectTLSWebSocket("localhost", "/probe", undefined, {
      port: server.port,
      ca: cert,
    });
    return await body(ws);
  } finally {
    server.stop();
  }
}

/** The predicate `geminiLiveWS` step 2 waits on. */
const isSetupComplete = (msg: unknown): boolean =>
  !!msg && typeof msg === "object" && "setupComplete" in msg;

// ---------------------------------------------------------------------------
// parseCloseFrame
// ---------------------------------------------------------------------------

describe("parseCloseFrame", () => {
  it("extracts the status code and the UTF-8 reason", () => {
    const reason = "Requested model is not supported for BidiGenerateContent.";
    const payload = serverCloseFrame(1008, reason).subarray(2);
    expect(parseCloseFrame(payload)).toEqual({ code: 1008, reason });
  });

  it("returns an empty reason when the frame carries only a code", () => {
    expect(parseCloseFrame(serverCloseFrame(1011).subarray(2))).toEqual({
      code: 1011,
      reason: "",
    });
  });

  it("reports 1005 (no status received) for an absent payload", () => {
    expect(parseCloseFrame(Buffer.alloc(0))).toEqual({ code: 1005, reason: "" });
  });

  it("reports 1005 for a malformed 1-byte payload rather than misreading a code", () => {
    // A status code is 2 bytes; one byte cannot be one. Must NOT be read as 0x03.
    expect(parseCloseFrame(Buffer.from([0x03]))).toEqual({ code: 1005, reason: "" });
  });

  it("preserves application-specific 4xxx codes", () => {
    expect(parseCloseFrame(serverCloseFrame(4429, "slow down").subarray(2))).toEqual({
      code: 4429,
      reason: "slow down",
    });
  });

  it("decodes a multi-byte UTF-8 reason without corrupting it", () => {
    const reason = "quota dépassé — 上限";
    expect(parseCloseFrame(serverCloseFrame(1008, reason).subarray(2)).reason).toBe(reason);
  });
});

// ---------------------------------------------------------------------------
// The refusal-vs-silence distinction — the whole point of the fix
// ---------------------------------------------------------------------------

describe("REGRESSION: a refused session reports WHY, a silent one still times out", () => {
  const REASON = "Requested model is not supported for BidiGenerateContent.";

  it("surfaces the CLOSE code and reason when the server refuses the session", async () => {
    const err = await withClient(
      (socket) => setTimeout(() => socket.write(serverCloseFrame(1008, REASON)), 10),
      async (ws) => {
        ws.send(JSON.stringify({ setup: { model: "models/gemini-2.5-flash" } }));
        return await ws.waitUntil(isSetupComplete, 2000).then(
          () => null,
          (e: unknown) => e,
        );
      },
    );

    expect(err).toBeInstanceOf(WSClosedError);
    const closed = err as WSClosedError;
    // Programmatically reachable, not just prose — a caller can classify on it.
    expect(closed.code).toBe(1008);
    expect(closed.reason).toBe(REASON);
    // And readable by a human reading CI logs.
    expect(closed.message).toContain("code=1008");
    expect(closed.message).toContain(REASON);
  });

  it("GUARD: a genuinely silent server is still reported as a timeout, never as a close", async () => {
    // The server accepts the upgrade and sends nothing, ever. Collapsing this
    // into a "close" would destroy the very distinction the fix exists for.
    const err = await withClient(
      () => {
        /* silence */
      },
      async (ws) => {
        ws.send(JSON.stringify({ setup: {} }));
        return await ws.waitUntil(isSetupComplete, 300).then(
          () => null,
          (e: unknown) => e,
        );
      },
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(WSClosedError);
    expect((err as Error).message).toContain("waitUntil timeout after 300ms");
  });

  it("reports the close for a waitUntil that starts after the server already closed", async () => {
    const err = await withClient(
      (socket) => setTimeout(() => socket.write(serverCloseFrame(1011, "internal error")), 10),
      async (ws) => {
        // Let the close land before anyone waits on the socket.
        await new Promise((r) => setTimeout(r, 150));
        return await ws.waitUntil(isSetupComplete, 2000).then(
          () => null,
          (e: unknown) => e,
        );
      },
    );

    expect(err).toBeInstanceOf(WSClosedError);
    expect((err as WSClosedError).code).toBe(1011);
    expect((err as WSClosedError).reason).toBe("internal error");
  });
});

// ---------------------------------------------------------------------------
// Normal operation must be untouched
// ---------------------------------------------------------------------------

describe("GUARD: normal operation is unchanged", () => {
  it("resolves when the awaited message and the CLOSE frame arrive in one segment", async () => {
    // The predicate must still win: a provider that answers and then hangs up
    // is a SUCCESS, not a refusal.
    const messages = await withClient(
      (socket) =>
        setTimeout(
          () =>
            socket.write(
              Buffer.concat([
                serverTextFrame(JSON.stringify({ setupComplete: {} })),
                serverCloseFrame(1000, "done"),
              ]),
            ),
          10,
        ),
      async (ws) => {
        ws.send(JSON.stringify({ setup: {} }));
        return await ws.waitUntil(isSetupComplete, 2000);
      },
    );

    expect(messages).toEqual([{ setupComplete: {} }]);
  });

  it("a clean close after a satisfied predicate raises nothing", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const messages = await withClient(
        (socket) => {
          setTimeout(
            () => socket.write(serverTextFrame(JSON.stringify({ setupComplete: {} }))),
            10,
          );
          // Echo the client's CLOSE (and ONLY its CLOSE), as a well-behaved
          // server would: opcode 0x8 with the client's mandatory mask bit.
          socket.on("data", (frame: Buffer) => {
            if (frame.length >= 1 && (frame[0] & 0x0f) === 0x8) {
              socket.write(serverCloseFrame(1000));
            }
          });
        },
        async (ws) => {
          ws.send(JSON.stringify({ setup: {} }));
          const collected = await ws.waitUntil(isSetupComplete, 2000);
          ws.close();
          // Give the echoed CLOSE time to arrive and be recorded.
          await new Promise((r) => setTimeout(r, 200));
          return collected;
        },
      );

      expect(messages).toEqual([{ setupComplete: {} }]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("still collects a normal multi-message turn", async () => {
    const messages = await withClient(
      (socket) =>
        setTimeout(() => {
          socket.write(serverTextFrame(JSON.stringify({ serverContent: { turnComplete: false } })));
          socket.write(serverTextFrame(JSON.stringify({ serverContent: { turnComplete: true } })));
        }, 10),
      async (ws) => {
        ws.send(JSON.stringify({ setup: {} }));
        return await ws.waitUntil(
          (m: unknown) =>
            (m as { serverContent?: { turnComplete?: boolean } })?.serverContent?.turnComplete ===
            true,
          2000,
        );
      },
    );

    expect(messages).toHaveLength(2);
  });
});
