# New / unclassified model family: gemini-3.5-transcribe-live

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

Rationale: wrong modality — a bidirectional streaming SPEECH-TO-TEXT surface.
This is the Live-API half of the same GA line as `gemini-3.5-transcribe` (one
model, two surfaces, two distinct normalized families, so both are enumerated).
Google's release note calls it "Low-latency, bidirectional streaming
speech-to-text over WebSockets" with "interim and finalized transcription
events", and the model card gives it the same input `Audio` -> output `Text,
Word annotations` signature as its unary sibling.

TWO INDEPENDENT capability facts were observed live, not inferred from the id:

  1. It DECLARES `bidiGenerateContent`. The Gemini Live leg's discovery
     (`fetchLiveCapableModels` in `ws-gemini-live.drift.ts`) filters SOLELY on
     that declared method and applies no name heuristic, and it selected this id
     — so the declaration is present.

  2. It CANNOT emit AUDIO. Google refused the resulting session out of band:
     `code=1007 reason="The requested combination of response modalities (AUDIO)
     is not supported by the model. models/gemini-3.5-transcribe-live"`
     (drift run 33296393200, 2026-08-30).

So it is a bidi Live surface that emits TEXT and cannot emit AUDIO — a streaming
transcriber, not a native-audio conversational model. It belongs to the realtime
canary's domain alongside the already-excluded `gemini-live`, and can never be
text-generation drift. Mirrors the OpenAI `gpt-live-transcribe` decision (PR
#343).

The same 1007 is ALSO the diagnosis for the Gemini Live leg's own failure; that
half is fixed in `ws-gemini-live.drift.ts`, not here.
