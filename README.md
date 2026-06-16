# presentation-gptdiff-realtime

Stream responses from NanoGPT's `xiaomi/mimo-v2.5-pro-ultraspeed` in the browser, through a
tiny local proxy that keeps the API key server-side.

```
browser (index.html)  ──POST /api/chat──▶  server.mjs (adds key)  ──▶  nano-gpt.com (stream)
```

## Why a local proxy instead of OAuth?

NanoGPT's in-browser OAuth PKCE flow is currently blocked by a `form-action 'self'` CSP on
their `/oauth/authorize` endpoint (full writeup + repro in [`nanogpt-bug-report.md`](./nanogpt-bug-report.md)).
Until that's fixed we authenticate with a plain API key read from the environment.

Auth is isolated in **`auth.mjs`** so it's a one-line swap later:

- **`auth.mjs`** — `getApiKey()`; default reads `NANOGPT_API_KEY`. Nothing else knows how the key was obtained.
- **`auth-oauth.mjs`** — the full PKCE loopback flow, kept ready. Set `NANOGPT_AUTH=oauth` to re-enable it.

## Setup

Requires Node 20+ (built-in `fetch`/`http`; zero dependencies).

```bash
cp .env.example .env        # then put your key in .env
# or: export NANOGPT_API_KEY=sk-nano-...
npm start
```

Open <http://localhost:8787>, type a prompt, hit **Send** — tokens stream in live.

Get a key at <https://nano-gpt.com> (Settings → API).

## Config (env vars)

| Var | Default | Notes |
|---|---|---|
| `NANOGPT_API_KEY` | — | Required in the default (`env`) auth mode. |
| `NANOGPT_MODEL` | `xiaomi/mimo-v2.5-pro-ultraspeed` | Any NanoGPT model id. |
| `PORT` | `8787` | Local proxy port. |
| `NANOGPT_AUTH` | `env` | Set to `oauth` to use the PKCE flow instead (once their CSP is fixed). |

## Files

- `server.mjs` — local proxy + static host
- `index.html` — streaming UI (calls `/api/chat`)
- `auth.mjs` / `auth-oauth.mjs` — swappable auth
- `nanogpt-bug-report.md` — the NanoGPT OAuth CSP bug report + repro
