#!/usr/bin/env node
// Tiny zero-dependency local proxy: serves index.html and forwards chat to NanoGPT,
// injecting the API key from auth.mjs so it never touches the browser.
//
//   browser  ->  POST /api/chat  ->  this server (adds key)  ->  nano-gpt.com (stream)
//
// Run: NANOGPT_API_KEY=sk-nano-... npm start    (or: node server.mjs)

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { buildEnvironment, generateDiff, smartapply, callLlmForApply } from "gptdiff-js";
import { getApiKey, setRuntimeKey, authStatus } from "./auth.mjs";

const NANOGPT = "https://nano-gpt.com";

const MODEL = process.env.NANOGPT_MODEL || "xiaomi/mimo-v2.5-pro-ultraspeed";
const PORT = Number(process.env.PORT || 8787);
const ROOT = dirname(fileURLToPath(import.meta.url));
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript" };

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/chat") return await chat(req, res);
    if (req.method === "GET" && req.url === "/api/auth") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ mode: authStatus() }));
    }
    if (req.method === "POST" && req.url === "/api/auth/exchange") return await authExchange(req, res);
    return await serveStatic(req, res);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

// Browser-side PKCE hands us the code; we exchange it for a key and hold it in memory,
// so the OAuth key — not the env key — is used from here on.
async function authExchange(req, res) {
  const { code, code_verifier, client_id, redirect_uri } = JSON.parse((await readBody(req)) || "{}");
  if (!code || !code_verifier || !client_id || !redirect_uri) throw new Error("missing PKCE fields");
  const r = await fetch(`${NANOGPT}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id, redirect_uri, code, code_verifier }),
  });
  if (!r.ok) {
    res.writeHead(r.status, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: await r.text() }));
  }
  setRuntimeKey((await r.json()).access_token);
  console.log("Signed in via OAuth ✓");
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, mode: "oauth" }));
}

// gptdiff flow, streamed: diff the existing files against the goal, smartapply, return new files.
//   request:  { goal: string, files: { [path]: content } }
//   response: Server-Sent Events, one JSON per `data:` line:
//     { t:"phase",  phase }                       — current stage
//     { t:"stream", phase, outChars }             — live count of generated characters
//     { t:"usage",  inTok, outTok, costUsd }      — exact cumulative tokens + USD cost
//     { t:"done",   diff, files } | { t:"error", error }
async function chat(req, res) {
  const { goal, prompt, files } = JSON.parse((await readBody(req)) || "{}");
  const instruction = goal || prompt || "";
  if (!instruction) throw new Error("missing 'goal'");
  if (!files || typeof files !== "object" || !Object.keys(files).length) throw new Error("missing 'files'");

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

  // Real, cumulative metrics across every underlying LLM call.
  let inTok = 0, outTok = 0, costUsd = 0, outChars = 0, lastTick = 0;

  // A streaming OpenAI-compatible client matching gptdiff's callLlm contract. It reports
  // live generated-char counts and reads NanoGPT's exact token/cost figures per call.
  const streamingCallLlm = (phase) => async ({ apiKey, baseUrl, model, messages, maxTokens = 30000, temperature = 1.0 }) => {
    send({ t: "phase", phase });
    const endpoint = (baseUrl || "https://nano-gpt.com/api/v1/").replace(/\/+$/, "") + "/chat/completions";
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: true }),
    });
    if (!r.ok) throw new Error(`LLM ${r.status}: ${await r.text()}`);

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "", content = "", pricing = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const tl = line.trim();
        if (!tl.startsWith("data:")) continue;
        const data = tl.slice(5).trim();
        if (data === "[DONE]") continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        const d = j.choices?.[0]?.delta;
        if (d) {
          if (d.content) { content += d.content; send({ t: "text", phase, chunk: d.content }); } // stream text live
          const piece = (d.content || "") + (d.reasoning || ""); // reasoning is billed output too
          if (piece) {
            outChars += piece.length;
            const now = Date.now();
            if (now - lastTick > 80) { lastTick = now; send({ t: "stream", phase, outChars, thinking: !content }); }
          }
        }
        if (j.x_nanogpt_pricing) pricing = j.x_nanogpt_pricing;
      }
    }
    inTok += pricing?.inputTokens ?? 0;
    outTok += pricing?.outputTokens ?? 0;
    costUsd += pricing?.costUsd ?? pricing?.cost ?? 0;
    send({ t: "usage", inTok, outTok, costUsd });
    return { choices: [{ message: { content } }] };
  };

  try {
    const apiKey = await getApiKey();
    // existing -> diff
    const diff = await generateDiff(buildEnvironment(files), instruction, {
      apiKey, model: MODEL, callLlm: streamingCallLlm("Generating diff"),
    });
    // diff -> new files (reuse gptdiff's apply prompt, but with our streaming client)
    const applyLlm = streamingCallLlm("Applying diff");
    const updated = await smartapply(diff, files, {
      apiKey, model: MODEL,
      callLlmForApply: (p, original, fileDiff, model, opts) =>
        callLlmForApply(p, original, fileDiff, model, { ...opts, callLlm: applyLlm }),
    });
    send({ t: "done", diff, files: updated });
  } catch (e) {
    send({ t: "error", error: e.message });
  }
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function serveStatic(req, res) {
  const pathname = req.url.split("?")[0]; // drop ?query (OAuth returns to /?code=...)
  const rel = pathname === "/" ? "/index.html" : pathname;
  const path = join(ROOT, normalize(rel).replace(/^(\.\.[/\\])+/, "")); // prevent traversal
  try {
    const data = await readFile(path);
    res.writeHead(200, { "Content-Type": TYPES[path.slice(path.lastIndexOf("."))] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

server.listen(PORT, async () => {
  console.log(`NanoGPT proxy → http://localhost:${PORT}`);
  console.log(`Model: ${MODEL}   Auth: ${process.env.NANOGPT_AUTH || "env"}`);
  // Warm the key at startup so OAuth sign-in (if enabled) happens now — opening the
  // browser at boot — instead of hanging the first /api/chat request mid-stream.
  try {
    await getApiKey();
    console.log("Auth ready ✓");
  } catch (e) {
    console.error("Auth not ready: " + e.message);
  }
});
