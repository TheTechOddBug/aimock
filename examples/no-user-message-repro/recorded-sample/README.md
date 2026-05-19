# Captured evidence

Two exhibits showing the bug:

- `input-messages-dump.json` — the request body sent to aimock. The user message's `content` is a structured array conforming to the AG-UI multimodal spec (`@ag-ui/core`'s `InputContentSchema`): a `text` part plus a `document` part with an embedded data source.
- `before-fix.json` — the fixture aimock wrote to `fixtures/agui-recorded/` in response. Note `match.message: "__NO_USER_MESSAGE__"` — the recorder lost the user's text because `extractLastUserMessage` only handles `typeof content === "string"`.

## How these were produced

`input-messages-dump.json` is a hand-crafted payload that matches the canonical AG-UI multimodal schema from `@ag-ui/core@0.0.53` (the `text` and `document` content part shapes). It was POSTed directly to the aimock recording proxy (`http://localhost:4010/`) while the upstream stub on `:4001` was running. The fixture aimock then wrote to disk is `before-fix.json`.

This synthetic payload demonstrates the bug independently of any specific client. To capture the exact wire shape produced by **CopilotKit's** AG-UI client when a user attaches a file in `<CopilotChat />`, run the full Next.js demo (see the parent `README.md`) and replace this file with the captured `input.messages` JSON. The bug is the same in either case: any non-string `content` triggers the sentinel.
