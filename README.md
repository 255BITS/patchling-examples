# presentation-gptdiff-realtime

Edit a file in the browser, describe a change, and let
[gptdiff-js](https://github.com/255BITS/gptdiff-js) **generate a unified diff and
smartapply it** via NanoGPT's `xiaomi/mimo-v2.5-pro-ultraspeed`. A tiny local proxy keeps
the API key server-side.

```
browser (index.html)  ──POST /api/chat──▶  server.mjs  ──▶  gptdiff-js
   { goal, files }                     (adds key)         generateDiff → smartapply
        ◀── { diff, files } ──────────────────────────────  (NanoGPT under the hood)
```

`/api/chat` takes the existing files + a goal, calls `generateDiff(buildEnvironment(files), goal)`
to produce a diff, then `smartapply(diff, files)` to apply it, and returns both the diff and
the new file map. gptdiff-js already defaults to NanoGPT's base URL and the same model, so the
server just hands it our key.

The two LLM calls take a few seconds, so the response is **streamed as Server-Sent Events** with
real progress — not a spinner. The server injects a streaming LLM client into gptdiff-js and
emits, per `data:` line:

| event | payload | meaning |
|---|---|---|
| `phase`  | `{ phase }` | current stage (Generating diff / Applying diff) |
| `text`   | `{ phase, chunk }` | generated text as it streams (shown building in the panes) |
| `stream` | `{ phase, outChars, thinking }` | live char count; `thinking` true while the model reasons before any output |
| `usage`  | `{ inTok, outTok, costUsd }` | exact cumulative input/output tokens + USD cost from NanoGPT |
| `done`   | `{ diff, files }` | final diff + new file map |

The UI shows ↓ input / ↑ output tokens, live cost, elapsed time, and the current phase while it works.

## Why a local proxy instead of OAuth?

NanoGPT's in-browser OAuth PKCE flow is currently blocked by a `form-action 'self'` CSP on
their `/oauth/authorize` endpoint (full writeup + repro in [`nanogpt-bug-report.md`](./nanogpt-bug-report.md)).
Until that's fixed we authenticate with a plain API key read from the environment.

Auth is isolated in **`auth.mjs`**:

- **`auth.mjs`** — `getApiKey()`; precedence is OAuth runtime key → `NANOGPT_AUTH=oauth` → `NANOGPT_API_KEY`.
- **In-page sign-in** — the header has a **Sign in with NanoGPT** link. It runs browser-side PKCE and
  posts the code to `POST /api/auth/exchange`; the server exchanges it and holds the key in memory, so
  the badge swaps to *via OAuth ✓* and the OAuth key is used instead of the env key. Serve over a
  loopback IP (`http://127.0.0.1:8787`, not `localhost`) — NanoGPT requires it; the page auto-corrects.
- **`auth-oauth.mjs`** — the server-side PKCE loopback flow (terminal), used when `NANOGPT_AUTH=oauth`.

## Setup

Requires Node 20+ (built-in `fetch`/`http`; zero dependencies).

```bash
cp .env.example .env        # then put your key in .env
# or: export NANOGPT_API_KEY=sk-nano-...
npm start
```

Open <http://localhost:8787>, edit the file + goal, hit **Diff & apply** — the generated diff
and the new file appear side by side. Hit **Replace editor with new file** to iterate.

Get a key at <https://nano-gpt.com> (Settings → API).

## Config (env vars)

| Var | Default | Notes |
|---|---|---|
| `NANOGPT_API_KEY` | — | Required in the default (`env`) auth mode. |
| `NANOGPT_MODEL` | `xiaomi/mimo-v2.5-pro-ultraspeed` | Any NanoGPT model id. |
| `PORT` | `8787` | Local proxy port. |
| `NANOGPT_AUTH` | `env` | Set to `oauth` to use the PKCE flow instead (once their CSP is fixed). |

## Files

- `server.mjs` — local proxy + static host; `/api/chat` runs the gptdiff-js diff→apply flow
- `index.html` — diff lab UI (file editor + goal → diff + new file)
- `auth.mjs` / `auth-oauth.mjs` — swappable auth
- `nanogpt-bug-report.md` — the NanoGPT OAuth CSP bug report + repro
