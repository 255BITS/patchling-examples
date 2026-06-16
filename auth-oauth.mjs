// OAuth PKCE flow (loopback server) — the "easy to swap back in" path.
//
// Currently NOT the default: NanoGPT's /oauth/authorize sends `form-action 'self'`, which
// blocks the browser redirect back to the app (see nanogpt-bug-report.md). Kept intact so
// that when they fix it, `NANOGPT_AUTH=oauth` re-enables this with no other changes.
//
// Exposes getApiKeyViaOAuth(): opens the browser, runs the PKCE dance against a local
// loopback callback, exchanges the code for a key, and caches it in .nanogpt.json.

import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = "https://nano-gpt.com";
const PORT = Number(process.env.NANOGPT_OAUTH_PORT || 8788); // distinct from the proxy port
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPE = "api.use models.read";
const STORE = join(dirname(fileURLToPath(import.meta.url)), ".nanogpt.json");

const load = () => (existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : {});
const save = (o) => writeFileSync(STORE, JSON.stringify(o, null, 2));
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const openBrowser = (url) => {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try { spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref(); } catch {}
};

async function getClientId(store) {
  if (store.client_id) return store.client_id;
  const res = await fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "NanoGPT Local Proxy",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  store.client_id = (await res.json()).client_id;
  save(store);
  return store.client_id;
}

async function signIn(store) {
  const clientId = await getClientId(store);
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  const authUrl = new URL(`${BASE}/oauth/authorize`);
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT_URI);
      if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const err = u.searchParams.get("error");
      const ok = !err && u.searchParams.get("state") === state && u.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<h2>${ok ? "Signed in — you can close this tab." : "Sign-in failed: " + (err || "bad state")}</h2>`);
      server.close();
      ok ? resolve(u.searchParams.get("code")) : reject(new Error(err || "state mismatch"));
    });
    server.listen(PORT, "127.0.0.1", () => {
      console.error("Opening browser to sign in with NanoGPT...");
      console.error(`If it doesn't open, visit:\n${authUrl}\n`);
      openBrowser(authUrl.toString());
    });
  });

  const res = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  store.api_key = (await res.json()).access_token;
  save(store);
  console.error("API key obtained and cached.\n");
  return store.api_key;
}

export async function getApiKeyViaOAuth() {
  const store = load();
  return store.api_key || signIn(store);
}
