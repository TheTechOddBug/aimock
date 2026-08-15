/**
 * Regression + guard tests for the drift WS client's FRAME HANDLING.
 *
 * THE BUG. `connectTLSWebSocket`'s RFC 6455 reader handled exactly three
 * opcodes — TEXT (0x1), CLOSE (0x8) and PING (0x9). Every other frame was
 * consumed off the buffer and then DROPPED ON THE FLOOR: no message recorded,
 * no counter incremented, no error raised. The FIN bit was never read at all,
 * so a fragmented message (a first frame with FIN=0 plus CONTINUATION frames,
 * opcode 0x0) was mis-parsed — the head was JSON.parse'd on its own and the
 * tail silently discarded.
 *
 * Two consequences, both fail-silent:
 *
 *   1. A provider that frames its JSON as BINARY (0x2) — which the Live wire
 *      permits, which `@google/genai` explicitly decodes (`event.data
 *      instanceof Blob` / `instanceof ArrayBuffer`), and which Google's own
 *      WebSocket sample reads with `ws.recv(decode=False)` — is observed by
 *      this client as a socket that upgraded and then said NOTHING.
 *   2. A provider that fragments a large message (an audio turn's base64
 *      `inlineData` is exactly the payload that gets fragmented) loses its tail.
 *
 * Both surface as the SAME string a genuinely mute server produces:
 *
 *   Error: waitUntil timeout after 30000ms. Collected 0 messages: [] bodies=[]
 *
 * which is byte-identical to the live Gemini Live drift observation. So "the
 * surface sent nothing" and "we could not read what the surface sent" were
 * indistinguishable — the probe reported its own deafness as provider silence.
 *
 * THE FIX, in two parts:
 *   - Read the frames: BINARY is decoded like TEXT, and FIN/CONTINUATION are
 *     reassembled. An opcode still not understood is COUNTED, never dropped.
 *   - Say what was seen: every timeout and every server-close now carries the
 *     per-opcode frame tally and the protocol step that was waiting, so a
 *     zero-message failure states whether zero FRAMES arrived (the surface
 *     really is mute) or whether frames arrived and were unreadable.
 *
 * These tests drive the REAL exported `connectTLSWebSocket` against a local TLS
 * server, using the repo's own `computeAcceptKey` for the upgrade. Nothing about
 * the client's framing is reimplemented here: the server writes raw RFC 6455
 * bytes and the client under test is the one the live legs run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as tls from "node:tls";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { computeAcceptKey } from "../../ws-framing.js";
import { connectTLSWebSocket, WSClosedError } from "./ws-providers.js";

// ---------------------------------------------------------------------------
// Local TLS WebSocket server
// ---------------------------------------------------------------------------

let certDir: string;
let key: Buffer;
let cert: Buffer;

beforeAll(() => {
  certDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-wsframe-"));
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

/**
 * Build an unmasked server-to-client frame.
 *
 * Written from RFC 6455 §5.2 directly rather than through the repo's own
 * `WebSocketConnection`, because these tests must be able to emit frame shapes
 * the repo's sender never produces — a BINARY frame, and an explicitly
 * fragmented FIN=0 head plus CONTINUATION tail.
 */
function serverFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const header: Buffer =
    payload.length < 126
      ? Buffer.alloc(2)
      : payload.length <= 0xffff
        ? Buffer.alloc(4)
        : Buffer.alloc(10);
  header[0] = (fin ? 0x80 : 0x00) | opcode;
  if (payload.length < 126) {
    header[1] = payload.length;
  } else if (payload.length <= 0xffff) {
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

const textFrame = (s: string, fin = true) => serverFrame(0x1, Buffer.from(s, "utf-8"), fin);
const binaryFrame = (s: string, fin = true) => serverFrame(0x2, Buffer.from(s, "utf-8"), fin);
const continuationFrame = (s: string, fin = true) => serverFrame(0x0, Buffer.from(s, "utf-8"), fin);

interface LocalServer {
  port: number;
  stop: () => void;
}

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

/** Resolve to the error instead of throwing, so it can be asserted on. */
const captureError = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

// ---------------------------------------------------------------------------
// THE READ GAP: frames the client was sent but could not see
// ---------------------------------------------------------------------------

describe("REGRESSION: a message the provider framed as BINARY is read, not dropped", () => {
  it("observes a BINARY-framed setupComplete", async () => {
    // RED (pre-fix): opcode 0x2 fell through every branch of the frame reader,
    // was sliced off the buffer and discarded, and this wait timed out having
    // "collected 0 messages" — the exact live Gemini Live observation.
    const messages = await withClient(
      (socket) => socket.write(binaryFrame(JSON.stringify({ setupComplete: {} }))),
      (ws) => ws.waitUntil(isSetupComplete, 2000),
    );

    expect(messages).toEqual([{ setupComplete: {} }]);
  });

  it("reads a BINARY-framed audio turn the same way it reads a TEXT one", async () => {
    // The payload shape the AUDIO leg grades on, delivered over the opcode the
    // client used to be blind to.
    const audio = {
      serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA" } }] } },
    };
    const messages = await withClient(
      (socket) => {
        socket.write(binaryFrame(JSON.stringify({ setupComplete: {} })));
        socket.write(binaryFrame(JSON.stringify(audio)));
        socket.write(binaryFrame(JSON.stringify({ serverContent: { turnComplete: true } })));
      },
      async (ws) => {
        await ws.waitUntil(isSetupComplete, 2000);
        return ws.waitUntil(
          (m: unknown) =>
            (m as { serverContent?: { turnComplete?: boolean } })?.serverContent?.turnComplete ===
            true,
          2000,
        );
      },
    );

    expect(messages).toEqual([audio, { serverContent: { turnComplete: true } }]);
  });
});

describe("REGRESSION: a fragmented message is reassembled, not truncated", () => {
  it("joins a FIN=0 TEXT head with its CONTINUATION tail into ONE message", async () => {
    // RED (pre-fix): the head was JSON.parse'd alone (invalid JSON -> pushed as
    // a raw string, which no predicate matches) and the tail was dropped.
    const json = JSON.stringify({ setupComplete: { sessionId: "abc" } });
    const cut = 12;
    const messages = await withClient(
      (socket) => {
        socket.write(textFrame(json.slice(0, cut), false));
        socket.write(continuationFrame(json.slice(cut), true));
      },
      (ws) => ws.waitUntil(isSetupComplete, 2000),
    );

    expect(messages).toEqual([{ setupComplete: { sessionId: "abc" } }]);
  });

  it("joins a fragmented BINARY message across MULTIPLE continuation frames", async () => {
    // An audio turn's base64 payload is precisely the message a provider
    // fragments, and it arrives on the binary opcode.
    const json = JSON.stringify({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: "QUJDREVGR0hJSks=" } }] } },
    });
    const third = Math.ceil(json.length / 3);
    const messages = await withClient(
      (socket) => {
        socket.write(binaryFrame(json.slice(0, third), false));
        socket.write(continuationFrame(json.slice(third, third * 2), false));
        socket.write(continuationFrame(json.slice(third * 2), true));
      },
      (ws) =>
        ws.waitUntil((m: unknown) => !!m && typeof m === "object" && "serverContent" in m, 2000),
    );

    expect(messages).toEqual([JSON.parse(json)]);
  });

  it("does not let an interleaved control frame corrupt a message being reassembled", async () => {
    // RFC 6455 §5.4: a control frame MAY be injected between fragments. It must
    // not be spliced into the message body.
    const json = JSON.stringify({ setupComplete: {} });
    const messages = await withClient(
      (socket) => {
        socket.write(textFrame(json.slice(0, 5), false));
        socket.write(serverFrame(0x9, Buffer.from("hb"))); // PING mid-message
        socket.write(continuationFrame(json.slice(5), true));
      },
      (ws) => ws.waitUntil(isSetupComplete, 2000),
    );

    expect(messages).toEqual([{ setupComplete: {} }]);
  });
});

// ---------------------------------------------------------------------------
// THE DIAGNOSTIC: a zero-message failure must say what the transport DID see
// ---------------------------------------------------------------------------

describe("a zero-message timeout distinguishes a mute surface from an unreadable one", () => {
  it("reports an all-zero frame tally when the server truly sends nothing", async () => {
    const err = (await withClient(
      () => {
        /* the provider says nothing at all */
      },
      (ws) => captureError(ws.waitUntil(isSetupComplete, 600, "setupComplete")),
    )) as Error;

    // The collector's recognizer parses this prefix; it must stay contiguous.
    expect(err.message).toContain("waitUntil timeout after 600ms. Collected 0 messages:");
    expect(err.message).toContain("step=setupComplete");
    expect(err.message).toContain("frames text=0 binary=0 continuation=0");
    expect(err.message).toContain("unhandled=0");
  });

  it("reports the frames it COULD NOT read rather than looking mute", async () => {
    // An opcode outside the set the client understands must be counted. This is
    // the assertion that makes "the surface sent nothing" a falsifiable claim:
    // pre-fix, this case and the one above produced identical text.
    const err = (await withClient(
      (socket) => socket.write(serverFrame(0x3, Buffer.from("reserved"))),
      (ws) => captureError(ws.waitUntil(isSetupComplete, 600, "setupComplete")),
    )) as Error;

    expect(err.message).toContain("Collected 0 messages:");
    expect(err.message).toContain("unhandled=1");
  });

  it("carries the frame tally and the step into a server-initiated CLOSE too", async () => {
    const err = (await withClient(
      (socket) => {
        socket.write(binaryFrame(JSON.stringify({ hello: true })));
        const payload = Buffer.alloc(2 + 6);
        payload.writeUInt16BE(1011, 0);
        payload.write("oops!!", 2);
        socket.write(serverFrame(0x8, payload));
      },
      (ws) => captureError(ws.waitUntil(isSetupComplete, 2000, "setupComplete")),
    )) as WSClosedError;

    expect(err).toBeInstanceOf(WSClosedError);
    expect(err.code).toBe(1011);
    expect(err.message).toContain("step=setupComplete");
    // One readable binary frame arrived before the close — evidence that the
    // transport was working and the provider still ended the session.
    expect(err.message).toContain("binary=1");
  });

  it("still reports a plain timeout, with a nonzero tally, when frames were read but none matched", async () => {
    const err = (await withClient(
      (socket) => {
        socket.write(textFrame(JSON.stringify({ somethingElse: 1 })));
        socket.write(textFrame(JSON.stringify({ andAnother: 2 })));
      },
      (ws) => captureError(ws.waitUntil(isSetupComplete, 600, "turn")),
    )) as Error;

    // Gate 2 of the collector's timeout recognizer: a nonzero collected count
    // must NOT be classified as a silent surface.
    expect(err.message).toContain("Collected 2 messages:");
    expect(err.message).toContain("frames text=2");
    expect(err.message).toContain("step=turn");
  });
});

// ---------------------------------------------------------------------------
// GUARDS: the tally cannot manufacture observations
// ---------------------------------------------------------------------------

describe("GUARD: the frame tally counts what actually arrived", () => {
  it("counts a PING as ping, not as a message", async () => {
    const err = (await withClient(
      (socket) => socket.write(serverFrame(0x9, Buffer.from("hb"))),
      (ws) => captureError(ws.waitUntil(isSetupComplete, 600, "setupComplete")),
    )) as Error;

    expect(err.message).toContain("Collected 0 messages:");
    expect(err.message).toContain("ping=1");
    expect(err.message).toContain("unhandled=0");
  });

  it("counts continuation frames separately from the message they complete", async () => {
    const err = (await withClient(
      (socket) => {
        // A fragmented message that never finishes: no message can be emitted.
        socket.write(textFrame('{"setup', false));
        socket.write(continuationFrame('Complete":', false));
      },
      (ws) => captureError(ws.waitUntil(isSetupComplete, 600, "setupComplete")),
    )) as Error;

    // An unterminated fragment sequence is NOT a message — it must not be
    // emitted early, and it must not be invisible either.
    expect(err.message).toContain("Collected 0 messages:");
    expect(err.message).toContain("text=1");
    expect(err.message).toContain("continuation=1");
  });
});
