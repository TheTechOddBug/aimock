import { describe, test, expect } from "vitest";
import {
  isImageResponse,
  isAudioResponse,
  isTranscriptionResponse,
  isVideoResponse,
  matchesPattern,
} from "../helpers.js";
import { matchFixture } from "../router.js";
import type { Fixture, ChatCompletionRequest, FixtureResponse } from "../types.js";

describe("multimedia type guards", () => {
  test("isImageResponse detects single image", () => {
    const r: FixtureResponse = { image: { url: "https://example.com/img.png" } };
    expect(isImageResponse(r)).toBe(true);
  });

  test("isImageResponse detects multiple images", () => {
    const r: FixtureResponse = {
      images: [{ url: "https://example.com/1.png" }, { url: "https://example.com/2.png" }],
    };
    expect(isImageResponse(r)).toBe(true);
  });

  test("isImageResponse rejects text response", () => {
    const r: FixtureResponse = { content: "hello" };
    expect(isImageResponse(r)).toBe(false);
  });

  test("isImageResponse rejects non-object image value", () => {
    const r = { image: "not-an-object" } as unknown as FixtureResponse;
    expect(isImageResponse(r)).toBe(false);
  });

  test("isAudioResponse detects audio (string form)", () => {
    const r: FixtureResponse = { audio: "AAAA", format: "mp3" };
    expect(isAudioResponse(r)).toBe(true);
  });

  test("isAudioResponse detects audio (object form with contentType)", () => {
    const r: FixtureResponse = { audio: { b64Json: "abc", contentType: "audio/mp3" } };
    expect(isAudioResponse(r)).toBe(true);
  });

  test("isAudioResponse detects audio (object form without contentType)", () => {
    const r: FixtureResponse = { audio: { b64Json: "abc" } };
    expect(isAudioResponse(r)).toBe(true);
  });

  test("isAudioResponse accepts empty b64Json (validation is in fixture-loader)", () => {
    const r: FixtureResponse = { audio: { b64Json: "" } };
    expect(isAudioResponse(r)).toBe(true);
  });

  test("isAudioResponse rejects numeric audio", () => {
    const r = { audio: 123 } as unknown as FixtureResponse;
    expect(isAudioResponse(r)).toBe(false);
  });

  test("isAudioResponse rejects object without b64Json", () => {
    const r = { audio: { foo: "bar" } } as unknown as FixtureResponse;
    expect(isAudioResponse(r)).toBe(false);
  });

  test("isAudioResponse rejects text response", () => {
    const r: FixtureResponse = { content: "hello" };
    expect(isAudioResponse(r)).toBe(false);
  });

  test("isTranscriptionResponse detects transcription", () => {
    const r: FixtureResponse = { transcription: { text: "hello" } };
    expect(isTranscriptionResponse(r)).toBe(true);
  });

  test("isTranscriptionResponse rejects text response", () => {
    const r: FixtureResponse = { content: "hello" };
    expect(isTranscriptionResponse(r)).toBe(false);
  });

  test("isVideoResponse detects video", () => {
    const r: FixtureResponse = {
      video: { id: "v1", status: "completed", url: "https://example.com/v.mp4" },
    };
    expect(isVideoResponse(r)).toBe(true);
  });

  test("isVideoResponse rejects text response", () => {
    const r: FixtureResponse = { content: "hello" };
    expect(isVideoResponse(r)).toBe(false);
  });
});

describe("endpoint filtering in matchFixture", () => {
  test("fixture with endpoint: image only matches image requests", () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "guitar", endpoint: "image" },
        response: { image: { url: "img.png" } },
      },
    ];
    const chatReq: ChatCompletionRequest = {
      model: "gpt-4",
      messages: [{ role: "user", content: "guitar" }],
      _endpointType: "chat",
    };
    expect(matchFixture(fixtures, chatReq)).toBeNull();

    const imageReq: ChatCompletionRequest = {
      model: "dall-e-3",
      messages: [{ role: "user", content: "guitar" }],
      _endpointType: "image",
    };
    expect(matchFixture(fixtures, imageReq)).toBe(fixtures[0]);
  });

  test("fixture without endpoint matches chat/embedding requests but not multimedia", () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "guitar" },
        response: { content: "Chat about guitars" },
      },
    ];
    // Chat requests match generic fixtures
    const chatReq: ChatCompletionRequest = {
      model: "gpt-4",
      messages: [{ role: "user", content: "guitar" }],
      _endpointType: "chat",
    };
    expect(matchFixture(fixtures, chatReq)).toBe(fixtures[0]);

    // Image requests do NOT match generic chat fixtures (prevents 500s)
    const imageReq: ChatCompletionRequest = {
      model: "dall-e-3",
      messages: [{ role: "user", content: "guitar" }],
      _endpointType: "image",
    };
    expect(matchFixture(fixtures, imageReq)).toBeNull();
  });

  test("endpoint filtering works with sequenceIndex", () => {
    const fixtures: Fixture[] = [
      {
        match: { userMessage: "g", endpoint: "image", sequenceIndex: 0 },
        response: { image: { url: "1.png" } },
      },
      {
        match: { userMessage: "g", endpoint: "image", sequenceIndex: 1 },
        response: { image: { url: "2.png" } },
      },
    ];
    const counts = new Map<Fixture, number>();
    const imageReq: ChatCompletionRequest = {
      model: "dall-e-3",
      messages: [{ role: "user", content: "g" }],
      _endpointType: "image",
    };

    // Pin the FULL sequence ordering this test claims to verify. matchFixture
    // gates a sequenced fixture on its match count equalling sequenceIndex but
    // does not itself mutate the count — the caller (journal) increments after
    // consuming a match, and crucially advances ALL sequenced siblings sharing
    // the same match criteria so the group shares one logical counter. Mimic
    // that here so each call advances to the next sequenceIndex, proving the
    // sequence resolves 0 → 1 in order and then exhausts.
    const advanceSequence = (matched: Fixture): void => {
      for (const f of fixtures) {
        if (f.match.sequenceIndex !== undefined) {
          counts.set(f, (counts.get(f) ?? 0) + 1);
        }
      }
      // (matched is part of the group; the loop above already advanced it)
      void matched;
    };
    const resolve = (): Fixture | null => {
      const f = matchFixture(fixtures, imageReq, counts);
      if (f) advanceSequence(f);
      return f;
    };

    expect(resolve()).toBe(fixtures[0]);
    expect(resolve()).toBe(fixtures[1]);
    // The sequence is exhausted: no fixture has a sequenceIndex matching the
    // next shared count, so further requests no longer match.
    expect(resolve()).toBeNull();
  });
});

describe("matchesPattern", () => {
  test("does not mutate the caller's RegExp lastIndex", () => {
    // A global regex carries mutable `lastIndex` state. matchesPattern must
    // not leave that state mutated, or callers reusing the same regex object
    // (e.g. the search/rerank/moderation filter loops) get inconsistent
    // results on subsequent uses.
    const re = /guitar/g;
    expect(matchesPattern("guitar", re)).toBe(true);
    // After the call, the caller's own use of the same regex must behave as if
    // matchesPattern never touched it.
    expect(re.lastIndex).toBe(0);
    expect(re.test("guitar")).toBe(true);
  });

  test("is consistent across repeated calls with the same global regex", () => {
    const re = /g/g;
    expect(matchesPattern("guitar", re)).toBe(true);
    expect(matchesPattern("guitar", re)).toBe(true);
    expect(matchesPattern("guitar", re)).toBe(true);
  });
});
