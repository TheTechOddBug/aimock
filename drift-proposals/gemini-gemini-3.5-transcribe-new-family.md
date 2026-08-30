# New / unclassified model family: gemini-3.5-transcribe

Provider: gemini
Detected: 2026-08-27
Status: RESOLVED — decision recorded below and applied to the registry

This model family appeared in a live /models listing but matches no classification rule (include, exclude, -preview, gemma). drift-sync never silently classifies a new family.

## Decision

<!-- drift-sync never auto-classifies a new family. To approve adding it to
     the registry, change the line below to `Decision: include` — the NEXT
     drift-sync run will then apply the mechanical registry edit (still
     zero-LLM: this is a human-authored decision, not generated code). -->

<!-- NOTE: the `Decision: include` marker documented above is drift-sync's
     AUTOMATED path, and it writes EXCLUSIVELY into `includeFamilies`
     (scripts/drift-sync.ts: addFamilyLiteralInSource(..., "includeFamilies", ...)).
     There is no automated exclude path, so an EXCLUDE decision is recorded here
     in prose and applied by hand — writing `include` would misclassify. -->

Decision: EXCLUDE (applied — excludeFamilies.gemini in
`src/__tests__/drift/model-registry.ts`, with the `excludeFamilies.gemini`
re-pin in `src/__tests__/drift/logic-pin.test.ts`).

Rationale: wrong modality — speech->text, not text generation. Google's model
card for the Gemini 3.5 Transcribe line (GA 2026-08-26) gives this id the
signature input `Audio (up to 1 hour)` -> output `Text, Word annotations`, and
the release note describes it as "High-accuracy, low-latency non-streaming
speech-to-text". It emits no chat completion of its own: the text it returns is
a transcript of the caller's audio, with speaker diarization and word-level
timestamps. That is the audio canary's domain, not this text check.

NOT rejected for the "transcribe" substring. The deciding evidence is the
provider-declared input/output signature, the same instrument used for
`gemini-3.7-flash-video-understanding-eap` (declared access status, not the
"video" in its name) and against which the native-audio misclassification was
caught. Mirrors the OpenAI `gpt-transcribe` / `gpt-live-transcribe` decisions
(PR #343).

Membership in `excludeFamilies` is a CLASSIFICATION for the `/models` listing
check in `models.drift.ts` and nothing more: it says the family is accounted
for, not which endpoints aimock implements for it.
