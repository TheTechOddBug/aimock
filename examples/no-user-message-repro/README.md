# aimock AG-UI repro: `__NO_USER_MESSAGE__` on file attachments

A minimal Next.js + CopilotKit project that reproduces a bug in `@copilotkit/aimock`'s AG-UI recorder:

When a CopilotKit chat user message includes a file attachment alongside text, the AG-UI client sends `content` as a structured array (`[{ type: "text", text: "..." }, { type: "file", ... }]`) instead of a plain string. `aimock`'s `extractLastUserMessage` only handles `typeof content === "string"`, so it returns `""`, and the recorder writes `match.message: "__NO_USER_MESSAGE__"` to disk. The resulting fixture is effectively unmatchable on replay.

See `recorded-sample/before-fix.json` and `recorded-sample/input-messages-dump.json` for a pre-captured exhibit.

## Architecture

```
Browser (:3000)              CopilotKit chat UI, file attachments enabled
   │
   ▼
Next.js /api/copilotkit       CopilotRuntime + HttpAgent
   │
   ▼
aimock (:4010)                AGUIMock recording proxy
   │
   ▼
upstream-agent (:4001)        Tiny SSE stub that returns a canned assistant reply
```

## Run

This example consumes the local aimock checkout via a `link:` dependency in `package.json` (`"@copilotkit/aimock": "link:../.."`). Build aimock first, then install + run this example:

From the **repo root** (`@copilotkit/aimock`):

```sh
pnpm install
pnpm build
```

From **this directory**:

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts three processes via `concurrently`:

- `upstream` on `:4001` — the noop SSE stub
- `aimock` on `:4010` — the recording proxy
- `next` on `:3000` — the Next.js dev server

## Reproduce

1. Open <http://localhost:3000>.
2. In the chat, click the paperclip icon and attach any small file (a `.txt` works fine).
3. Type a message like `summarize this` and send.
4. Wait for the assistant reply ("Got it — recorded by aimock.").
5. Look in `fixtures/agui-recorded/`. You will find a file named `agui-<timestamp>-<id>.json`:
   ```json
   {
     "fixtures": [
       {
         "match": { "message": "__NO_USER_MESSAGE__" },
         "events": [ ... ]
       }
     ]
   }
   ```
   `match.message` is the sentinel rather than the user's actual text.

## Headless repro (no browser)

If you want to verify the bug without spinning up Next.js, start just `upstream` and `aimock`, then POST the bundled synthetic payload directly:

```sh
pnpm upstream &
pnpm aimock &
curl -X POST http://localhost:4010/ \
  -H 'Content-Type: application/json' \
  --data-binary @structured-input.json
cat fixtures/agui-recorded/agui-*.json
```

`structured-input.json` is a hand-crafted `RunAgentInput` whose user message uses the canonical AG-UI multimodal schema (`text` + `document` parts). The resulting fixture on disk shows `match.message: "__NO_USER_MESSAGE__"` — same bug, no UI required.

## Compare to a text-only message

Send a plain text message (no attachment) from the chat and look at the resulting fixture — `match.message` contains the actual user text. The bug only manifests when `content` is structured (which currently means: when there's an attachment).

## Notes

- This example is not part of the aimock test suite — it's a manual reproduction for the upstream issue.
- `concurrently` shuts down all three processes when you Ctrl-C the parent.
- Recorded fixtures land under `fixtures/agui-recorded/` and are gitignored.
