// Swappable auth for NanoGPT.
//
// Default ("env"): read NANOGPT_API_KEY from the environment. This is the current path
// because NanoGPT's in-browser OAuth is blocked by their `form-action 'self'` CSP on
// /oauth/authorize (see nanogpt-bug-report.md).
//
// When they fix that, flip a single env var — NANOGPT_AUTH=oauth — and the PKCE loopback
// flow in auth-oauth.mjs becomes the key source again. No other code changes.
//
// Everything that needs a key calls getApiKey(); nothing else knows how it was obtained.

const MODE = process.env.NANOGPT_AUTH || "env";

export async function getApiKey() {
  if (MODE === "oauth") {
    const { getApiKeyViaOAuth } = await import("./auth-oauth.mjs");
    return getApiKeyViaOAuth();
  }
  const key = process.env.NANOGPT_API_KEY;
  if (!key) {
    throw new Error(
      "NANOGPT_API_KEY is not set. Get a key at https://nano-gpt.com (Settings → API), then:\n" +
      "  export NANOGPT_API_KEY=sk-nano-...\n" +
      "Or, once NanoGPT's OAuth CSP is fixed, set NANOGPT_AUTH=oauth to use the PKCE flow."
    );
  }
  return key;
}
