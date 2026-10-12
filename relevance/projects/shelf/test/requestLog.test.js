import assert from "node:assert/strict";
import test from "node:test";
import { formatLog } from "../src/middleware/requestLog.js";

test("request log line is method, path, status, and milliseconds", () => {
  const line = formatLog(
    { method: "GET", path: "/books" },
    { statusCode: 200 },
    3,
  );
  assert.equal(line, "GET /books 200 3ms");
  assert.equal(line.includes("req_"), false);
});
