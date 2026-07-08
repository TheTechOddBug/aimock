/**
 * Known voice/audio model set + drift detection for the OpenAI realtime canary.
 *
 * Extracted into its own side-effect-free module (no `describe`/`beforeAll`) so
 * both the live canary in ws-realtime.drift.ts AND its unit test can import the
 * SAME detection code path without the unit test transitively registering the
 * drift suite (which would spin up the drift server).
 */

/**
 * The GA realtime model family. At least one of these MUST appear in the
 * account's model list, otherwise the family was renamed/removed (NO_GA drift).
 */
export const gaRealtimeModels = [
  "gpt-realtime",
  "gpt-realtime-2",
  "gpt-realtime-2.1",
  "gpt-realtime-2.1-mini",
  "gpt-realtime-2025-08-28",
  "gpt-realtime-1.5",
  "gpt-realtime-mini",
  "gpt-realtime-mini-2025-10-06",
  "gpt-realtime-mini-2025-12-15",
];

/**
 * The full set of voice/audio model ids we already know about. Any voice/audio
 * model id NOT in this set is surfaced as new/unknown drift so a newly-shipped
 * family is flagged the first time it appears on the account.
 */
export const knownVoiceModels = new Set([
  ...gaRealtimeModels,
  // Translate/whisper models (also contain "realtime" in some variants)
  "gpt-realtime-translate",
  "gpt-realtime-whisper",
  // Audio models also valid in realtime sessions
  "gpt-audio",
  "gpt-audio-1.5",
  "gpt-audio-mini",
  "gpt-audio-mini-2025-10-06",
  "gpt-audio-mini-2025-12-15",
  // Transcription/translation models
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
  "gpt-4o-transcribe-diarize",
  "whisper-1",
  // Legacy preview models (may still appear)
  "gpt-4o-realtime-preview",
  "gpt-4o-mini-realtime-preview",
  "gpt-4o-realtime-preview-2024-10-01",
  "gpt-4o-realtime-preview-2024-12-17",
  "gpt-4o-realtime-preview-2025-06-03",
  "gpt-4o-mini-realtime-preview-2024-12-17",
  // TTS / speech-out models (voice family, no "realtime" substring)
  "gpt-4o-mini-tts",
  "tts-1",
  "tts-1-hd",
]);

/**
 * Match a model id that belongs to the voice/audio family the realtime canary
 * is responsible for. This is DELIBERATELY broader than the old
 * `id.includes("realtime")` filter: a new full-duplex voice family whose id
 * lacks the "realtime" substring (e.g. OpenAI's `gpt-live-1` / `gpt-live-1-mini`)
 * would previously never enter the unknown-model computation and so slip past
 * the canary silently. Matching on the broader voice/audio vocabulary closes
 * that blind spot generally — the point is "a new audio/voice model family the
 * account hasn't seen before gets flagged", not a one-off hardcode of gpt-live.
 *
 * Chat/text/image/embedding models (gpt-4o, gpt-5, dall-e, text-embedding-*,
 * etc.) do NOT match, so they never become false-positive "unknown voice" drift.
 */
export function isVoiceModelId(id: string): boolean {
  return /(?:realtime|audio|\blive\b|-live|transcribe|whisper|voice|\btts\b|-tts)/i.test(id);
}

/**
 * Result of running the known-voice-models drift detection over a model list.
 */
export interface VoiceModelDriftResult {
  /** Every model id that matched the voice/audio family matcher. */
  candidateModels: string[];
  /** Voice/audio ids not present in knownVoiceModels — new/unknown drift. */
  unknown: string[];
  /** Whether at least one GA realtime model is present. */
  hasGA: boolean;
}

/**
 * The single detection code path shared by the live canary AND its unit test.
 * Given a raw `GET /v1/models` id list, compute the voice/audio candidates, the
 * unknown (new-family) subset, and GA presence. Keeping this pure lets the unit
 * test drive the EXACT logic the live canary runs against a representative
 * payload without a network call.
 */
export function detectVoiceModelDrift(models: string[]): VoiceModelDriftResult {
  const candidateModels = models.filter(isVoiceModelId);
  const unknown = candidateModels.filter((m) => !knownVoiceModels.has(m));
  const hasGA = candidateModels.some((m) => gaRealtimeModels.includes(m));
  return { candidateModels, unknown, hasGA };
}
