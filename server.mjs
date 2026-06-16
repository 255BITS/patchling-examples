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
import { getApiKey } from "./auth.mjs";

const BASE = "https://nano-gpt.com";
const MODEL = process.env.NANOGPT_MODEL || "xiaomi/mimo-v2.5-pro-ultraspeed";
const PORT = Number(process.env.PORT || 8787);
const ROOT = dirname(fileURLToPath(import.meta.url));
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript" };

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/chat") return await chat(req, res);
    return await serveStatic(req, res);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

// Forward a streaming chat completion, key added server-side.
async function chat(req, res) {
  const { messages, prompt } = JSON.parse((await readBody(req)) || "{}");
  const msgs = messages || [{ role: "user", content: prompt || "" }];
  const key = await getApiKey();

  const upstream = await fetch(`${BASE}/api/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: msgs, stream: true }),
  });
  if (!upstream.ok) {
    res.writeHead(upstream.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: await upstream.text() }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const reader = upstream.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    res.write(value); // pass the SSE bytes through untouched
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
  const rel = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const path = join(ROOT, normalize(rel).replace(/^(\.\.[/\\])+/, "")); // prevent traversal
  try {
    const data = await readFile(path);
    res.writeHead(200, { "Content-Type": TYPES[path.slice(path.lastIndexOf("."))] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

server.listen(PORT, () => {
  console.log(`NanoGPT proxy → http://localhost:${PORT}`);
  console.log(`Model: ${MODEL}   Auth: ${process.env.NANOGPT_AUTH || "env"}`);
});
