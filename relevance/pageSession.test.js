import assert from "node:assert/strict";
import test from "node:test";
import { createPageSession } from "./pageSession.js";

test("a task change drops an in-flight decision instead of pushing onto null", () => {
  const session = createPageSession();
  const state = { decisions: [], relevant: { "a.js": "old" } };
  const run = session.beginFilter();
  session.invalidate();
  state.decisions = null;
  state.relevant = null;
  const accepted = session.acceptDecision(run, state, { path: "a.js", relevant: true });
  assert.equal(accepted, false);
  assert.equal(state.decisions, null);
  assert.equal(session.publishFilter(run, state, {
    decisions: [{ path: "a.js" }],
    relevant: { "a.js": "stale" },
  }), false);
  assert.equal(state.relevant, null);
});

test("a new filter replaces relevance only for the current run", () => {
  const session = createPageSession();
  const state = { decisions: [{ path: "stale.js" }], relevant: { "stale.js": "old" } };
  const first = session.beginFilter();
  const second = session.beginFilter();
  assert.equal(session.publishFilter(first, state, {
    decisions: [{ path: "stale.js" }],
    relevant: { "stale.js": "old" },
  }), false);
  assert.deepEqual(state.relevant, { "stale.js": "old" });
  assert.equal(session.publishFilter(second, state, {
    decisions: [{ path: "fresh.js" }],
    relevant: { "fresh.js": "new" },
  }), true);
  assert.deepEqual(state.decisions, [{ path: "fresh.js" }]);
  assert.deepEqual(state.relevant, { "fresh.js": "new" });
});

test("an apply started before a re-filter does not publish", () => {
  const session = createPageSession();
  const snapshot = { "a.js": "before" };
  const apply = session.beginApply();
  session.beginFilter();
  let rendered = null;
  if (session.isCurrent(apply)) rendered = snapshot;
  assert.equal(rendered, null);
  assert.equal(session.isCurrent(apply), false);
  const later = session.beginApply();
  if (session.isCurrent(later)) rendered = snapshot;
  assert.equal(rendered, snapshot);
});
