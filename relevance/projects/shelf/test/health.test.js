import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { health } from "../src/routes/health.js";

test("GET /health reports only liveness", async () => {
  const app = express();
  app.use("/health", health);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
