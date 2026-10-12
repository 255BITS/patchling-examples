import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { load, reset } from "../src/db.js";
import { authors } from "../src/routes/authors.js";

test("GET /authors counts books per author", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shelf-"));
  const path = join(dir, "seed.json");
  writeFileSync(
    path,
    JSON.stringify({
      books: [
        { id: "1", title: "A", author: "Maeve Lorne", priceCents: 1 },
        { id: "2", title: "B", author: "Maeve Lorne", priceCents: 1 },
        { id: "3", title: "C", author: "Idris Cho", priceCents: 1 },
      ],
    }),
  );
  reset();
  load(path);
  const app = express();
  app.use("/authors", authors);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const body = await (await fetch(`http://127.0.0.1:${port}/authors`)).json();
    assert.deepEqual(body.authors, [
      { name: "Idris Cho", bookCount: 1 },
      { name: "Maeve Lorne", bookCount: 2 },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    reset();
  }
});
