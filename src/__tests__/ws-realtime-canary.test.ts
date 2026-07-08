/**
 * Unit test for the ws-realtime known-voice-models drift canary.
 *
 * This drives the SAME detection code path the live canary runs
 * (`detectVoiceModelDrift` from ws-realtime.drift.ts) against a representative
 * `GET /v1/models` id list — no network call, but NOT a reimplemented fake: the
 * exported function under test IS the one the live canary invokes.
 *
 * Regression guard for the voice-model-family blind spot: the canary used to
 * filter the model list with `models.filter((m) => m.includes("realtime"))`, so
 * a NEW full-duplex voice family whose id lacks the "realtime" substring (e.g.
 * OpenAI's gpt-live-1 / gpt-live-1-mini) never entered the unknown-model
 * computation and slipped past the canary silently. The broadened voice/audio
 * matcher closes that blind spot generally.
 */

import { describe, it, expect } from "vitest";
import { detectVoiceModelDrift, isVoiceModelId, knownVoiceModels } from "./drift/voice-models.js";

// A representative GET /v1/models id list: the known GA realtime family, some
// known audio/transcribe/tts models, a batch of non-voice chat/image/embedding
// models that MUST NOT be flagged, and the newly-shipped gpt-live-* full-duplex
// voice family that the old "realtime"-substring filter would have missed.
const REPRESENTATIVE_MODELS = [
  // --- known voice/audio family (should stay green) ---
  "gpt-realtime",
  "gpt-realtime-2.1",
  "gpt-realtime-mini",
  "gpt-audio-mini",
  "gpt-4o-transcribe",
  "whisper-1",
  "gpt-4o-realtime-preview",
  "tts-1",
  // --- non-voice models (must NOT be flagged as voice drift) ---
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-5",
  "gpt-5-mini",
  "o1",
  "o3-mini",
  "chatgpt-4o-latest",
  "dall-e-3",
  "text-embedding-3-large",
  "text-embedding-3-small",
  "omni-moderation-latest",
  // --- NEW voice family with no "realtime" substring (the blind spot) ---
  "gpt-live-1",
  "gpt-live-1-mini",
];

describe("ws-realtime known-voice-models canary detection", () => {
  it("flags a new voice family whose id lacks the 'realtime' substring (gpt-live-*)", () => {
    const { unknown } = detectVoiceModelDrift(REPRESENTATIVE_MODELS);

    // The whole point: the new gpt-live-* family is surfaced as unknown drift.
    expect(unknown).toContain("gpt-live-1");
    expect(unknown).toContain("gpt-live-1-mini");
  });

  it("does not flag legitimately-known voice/audio models (no false positives)", () => {
    const { unknown } = detectVoiceModelDrift(REPRESENTATIVE_MODELS);

    // Every known-voice model in the payload stays green.
    for (const known of [
      "gpt-realtime",
      "gpt-realtime-2.1",
      "gpt-realtime-mini",
      "gpt-audio-mini",
      "gpt-4o-transcribe",
      "whisper-1",
      "gpt-4o-realtime-preview",
      "tts-1",
    ]) {
      expect(knownVoiceModels.has(known)).toBe(true);
      expect(unknown).not.toContain(known);
    }
  });

  it("does not flag non-voice chat/image/embedding models as voice drift", () => {
    const { candidateModels, unknown } = detectVoiceModelDrift(REPRESENTATIVE_MODELS);

    for (const nonVoice of [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-5",
      "gpt-5-mini",
      "o1",
      "o3-mini",
      "chatgpt-4o-latest",
      "dall-e-3",
      "text-embedding-3-large",
      "text-embedding-3-small",
      "omni-moderation-latest",
    ]) {
      expect(isVoiceModelId(nonVoice)).toBe(false);
      expect(candidateModels).not.toContain(nonVoice);
      expect(unknown).not.toContain(nonVoice);
    }
  });

  it("reports GA realtime presence when a GA model exists", () => {
    const { hasGA } = detectVoiceModelDrift(REPRESENTATIVE_MODELS);
    expect(hasGA).toBe(true);
  });

  it("gpt-live-* is the ONLY unknown in the representative payload", () => {
    // Confirms the matcher is neither too narrow (misses gpt-live) nor too broad
    // (drags in non-voice models). The unknown set is exactly the new family.
    const { unknown } = detectVoiceModelDrift(REPRESENTATIVE_MODELS);
    expect([...unknown].sort()).toEqual(["gpt-live-1", "gpt-live-1-mini"]);
  });
});
