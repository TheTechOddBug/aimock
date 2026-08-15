# New / unclassified model family: gemini-3.7-flash-video-understanding-eap

Provider: gemini
Detected: 2026-08-15
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

Rationale: gated PRE-GA surface, not a stable tier. This is the only one of the
54 entries in the live Gemini /models listing whose provider-declared
`displayName` AND `description` are "[Confidential] Gemini 3.7 Flash Video
Understanding EAP" — an Early Access Program model visible only to allowlisted
keys. aimock does not mock pre-GA surfaces, which is exactly the policy
PREVIEW_FAMILY applies to every `-preview` tier; this id carries no trailing
`-preview` token, so that rule cannot reach it and it must be enumerated.

NOT rejected for being "video" by name. It genuinely declares
`supportedGenerationMethods: [generateContent, countTokens, createCachedContent,
batchGenerateContent]` — the same method set as its GA sibling
`gemini-3.7-flash` — so it IS text-capable, and a name-substring rule would have
been the wrong instrument (compare the native-audio misclassification, where the
declared capability, not the id, was the deciding evidence: the live
`gemini-2.5-flash-native-audio-latest` entry declares only `countTokens` and
`bidiGenerateContent`, and no `generateContent` at all). The disqualifier here is
access status, and it is provider-declared metadata rather than an inference from
the id string.
