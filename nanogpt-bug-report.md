# Bug: `form-action 'self'` CSP on `/oauth/authorize` breaks the browser PKCE flow

**Summary.** `https://nano-gpt.com/oauth/authorize` is served with a `Content-Security-Policy`
containing `form-action 'self'`. After the user approves the consent screen, the browser
**refuses to follow the redirect back to the registered `redirect_uri`** (it isn't `'self'`),
so the app never receives the authorization code. This makes the documented browser-based
[Sign in with NanoGPT (OAuth PKCE)](https://nano-gpt.com/blog/sign-in-with-nanogpt-oauth-pkce)
flow impossible to complete in Chromium for any external `redirect_uri`.

## Environment

- Browser: Chromium-based (Chrome / Edge / Brave), current stable.
- Public PKCE client via `POST /oauth/register` (`token_endpoint_auth_method: "none"`).
- Fails identically for loopback (`http://127.0.0.1:PORT/`) and public HTTPS
  (`https://*.trycloudflare.com/`) redirect URIs — so it is not origin-specific.

## Steps to reproduce

1. Register a public PKCE client with an external `redirect_uri`.
2. Navigate the browser to
   `GET /oauth/authorize?response_type=code&client_id=...&redirect_uri=<external>&scope=api.use%20models.read&state=...&code_challenge=...&code_challenge_method=S256`
3. Log in, reach the consent screen, click **Approve**.

(The HTML at the bottom is a self-contained reproduction — serve it over HTTPS and click the button.)

## Expected

Browser follows the `303` to `<redirect_uri>?code=...&state=...`; the app exchanges the code
at `/oauth/token` for an access token.

## Actual (console)

```
Refused to send form data to 'https://nano-gpt.com/oauth/authorize'
because it violates the following Content Security Policy directive: "form-action 'self'".
```

The user is stranded on nano-gpt.com; the app never receives the authorization code.

## Root cause

`/oauth/authorize` responds with:

```
content-security-policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'
```

The consent form posts to nano-gpt.com (fine), but the server then `303`s to the external
`redirect_uri`. Chromium enforces `form-action` against that redirect target; since it isn't
`'self'`, the navigation is blocked. An OAuth authorization endpoint must redirect to external
`redirect_uri`s, so `form-action 'self'` is fundamentally incompatible with the consent→redirect
step. (The console names the form action URL rather than the redirect target — a known Chromium
reporting quirk for redirect-blocked submissions.)

## Proof it's only the redirect that's blocked

After approving: DevTools → Network → the `authorize` POST → Response Headers → copy `Location`
(it contains `?code=…&state=…`). Paste it into the **same tab's** address bar and press Enter — a
manual navigation is not a form submission, so CSP does not apply, and sign-in then completes. The
server issued a valid code; only the CSP-governed redirect hop is broken.

## Suggested fix (any one)

1. Don't emit `form-action 'self'` on `/oauth/authorize` (and its POST handler).
2. Scope it to the validated redirect origin, e.g.
   `form-action 'self' https://app.example.com http://127.0.0.1:*`.
3. Complete the handoff via a `200` page doing a top-level `Location`/JS redirect, which
   `form-action` does not govern.

## Self-contained reproduction (single HTML file)

Save as `repro.html`, serve over HTTPS (`npx serve .` then `npx cloudflared tunnel --url http://localhost:3000`),
open the https URL, click the button, log in, and click **Approve**.

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>NanoGPT PKCE CSP repro</title></head>
<body>
<h1>NanoGPT browser PKCE — minimal repro</h1>
<p>Serve over HTTPS, click the button, log in, click <b>Approve</b>. The redirect back here is
   blocked by the <code>form-action 'self'</code> CSP on <code>/oauth/authorize</code>.</p>
<button id="signin">Sign in with NanoGPT</button>
<pre id="log"></pre>

<script type="module">
const BASE = "https://nano-gpt.com";
const REDIRECT_URI = location.origin + location.pathname; // this page
const log = (m) => (document.getElementById("log").textContent += m + "\n");

const b64url = (b) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rand = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256url = async (s) => b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

// Register a public PKCE client (client_id is not secret); cache so we reuse one id.
async function clientId() {
  const cached = sessionStorage.getItem("client_id");
  if (cached) return cached;
  const r = await fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "PKCE CSP repro",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!r.ok) throw new Error(`register ${r.status}: ${await r.text()}`);
  const id = (await r.json()).client_id;
  sessionStorage.setItem("client_id", id);
  return id;
}

// Click -> redirect browser to the authorization endpoint.
document.getElementById("signin").onclick = async () => {
  try {
    const id = await clientId();
    const verifier = rand(32), state = rand(16);
    sessionStorage.setItem("pkce", JSON.stringify({ verifier, state }));
    const u = new URL(`${BASE}/oauth/authorize`);
    u.search = new URLSearchParams({
      response_type: "code",
      client_id: id,
      redirect_uri: REDIRECT_URI,
      scope: "api.use models.read",
      state,
      code_challenge: await sha256url(verifier),
      code_challenge_method: "S256",
    }).toString();
    log("redirecting to authorize…");
    // After approving consent, NanoGPT 303-redirects back here. Chromium BLOCKS that redirect
    // because the consent page sets `form-action 'self'` and this origin is not 'self'. The
    // ?code handler below is therefore never reached automatically.
    location.assign(u.toString());
  } catch (e) {
    log("ERROR: " + e.message);
  }
};

// On return with ?code -> exchange for token (proves success when actually reached).
(async () => {
  const p = new URLSearchParams(location.search);
  if (!p.has("code")) return;
  const saved = JSON.parse(sessionStorage.getItem("pkce") || "null");
  if (!saved || p.get("state") !== saved.state) return log("state mismatch");
  const id = await clientId();
  const r = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", client_id: id, redirect_uri: REDIRECT_URI,
      code: p.get("code"), code_verifier: saved.verifier,
    }),
  });
  log(r.ok ? "SUCCESS — got token: " + (await r.json()).access_token.slice(0, 12) + "…"
           : `token ${r.status}: ${await r.text()}`);
})();
</script>
</body>
</html>
```
