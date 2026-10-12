import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { reset, load } from "../src/db.js";
import { books } from "../src/routes/books.js";

function seedPath() {
  const dir = mkdtempSync(join(tmpdir(), "shelf-"));
  const path = join(dir, "seed.json");
  writeFileSync(
    path,
    JSON.stringify({
      books: [
        { id: "bk_a", slug: "alpha", title: "Alpha", author: "Ada", priceCents: 1000, tags: [] },
        { id: "bk_b", slug: "beta", title: "Beta", author: "Bea", priceCents: 2500, tags: ["fiction"] },
      ],
    }),
  );
  return path;
}

async function withBooks(fn) {
  reset();
  load(seedPath());
  const app = express();
  app.use(express.json());
  app.use("/books", books);
  const server = app.listen(0);
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    reset();
  }
}

test("GET /books returns the whole catalog and no formatted price", async () => {
  await withBooks(async (base) => {
    const body = await (await fetch(`${base}/books`)).json();
    assert.equal(body.books.length, 2);
    assert.equal(body.books[0].priceCents, 1000);
    assert.equal("priceUsd" in body.books[0], false);
    assert.equal(body.nextCursor, undefined);
  });
});

test("POST /books rejects a missing title", async () => {
  await withBooks(async (base) => {
    const res = await fetch(`${base}/books`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ author: "Ada", priceCents: 500 }),
    });
    assert.equal(res.status, 400);
  });
});
