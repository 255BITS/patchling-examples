// Swappable auth for NanoGPT.
//
// Precedence: a runtime key from browser OAuth sign-in (set via /api/auth/exchange)
// wins; otherwise NANOGPT_AUTH=oauth runs the server-side PKCE loopback flow; otherwise
// NANOGPT_API_KEY from the environment ("env", the default).
//
// Everything that needs a key calls getApiKey(); nothing else knows how it was obtained.

const MODE = process.env.NANOGPT_AUTH || "env";

let runtimeKey = null; // set when the user signs in via the in-page "Sign in with NanoGPT" link

export function setRuntimeKey(key) {
  runtimeKey = key || null;
}

// What the UI badge should show: "oauth" once signed in, else "env" / "none".
export function authStatus() {
  if (runtimeKey) return "oauth";
  return process.env.NANOGPT_API_KEY ? "env" : "none";
}

export async function getApiKey() {
  if (runtimeKey) return runtimeKey;
  if (MODE === "oauth") {
    const { getApiKeyViaOAuth } = await import("./auth-oauth.mjs");
    return getApiKeyViaOAuth();
  }
  const key = process.env.NANOGPT_API_KEY;
  if (!key) {
    throw new Error(
      'No API key yet. Click "Sign in with NanoGPT" in the page, or set NANOGPT_API_KEY ' +
      "(get one at https://nano-gpt.com → Settings → API)."
    );
  }
  return key;
}
