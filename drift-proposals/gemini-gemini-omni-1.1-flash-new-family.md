# New / unclassified model family: gemini-omni-1.1-flash

Provider: gemini
Detected: 2026-08-28
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

Rationale: non-text generative media. Google's 2026-08-27 release note announces
`gemini-omni-1.1-flash` as "the GA version of our fast, conversational video
generation and editing model", and its model-card signature is input `Video with
audio` -> output `Video with audio` (scene extension to 40s, keyframe
interpolation, 360p-4K upscale). It produces no text turn at all, so it cannot
be text-generation drift. Same category as the already-excluded `veo-*`,
`lyria-*` and `imagen-*` entries.

NOT classified from the "omni" substring — which would have argued the OPPOSITE.
"omni" names OpenAI's TEXT-capable omni line (`omni-moderation`, and the `gpt-4o`
"omni" lineage), so a name-shaped rule here would have read this as a
text-capable multimodal chat tier and INCLUDED it. The provider-declared
input/output signature is what decides it, exactly as with
`gemini-3.7-flash-video-understanding-eap`.

Its `-preview` sibling `gemini-omni-flash-preview` is already auto-excluded by
the PREVIEW_FAMILY rule. This GA id carries no trailing `-preview` token, so
that rule cannot reach it and it must be enumerated (mirrors the
`-preview-tts` / `-preview-customtools` entries).
