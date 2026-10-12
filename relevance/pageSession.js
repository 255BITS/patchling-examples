/**
 * Generation guard for the relevance walkthrough.
 * Browser-safe: no node imports. A task change or a new filter invalidates
 * in-flight decisions and applies so a stale callback cannot publish.
 */

export function createPageSession() {
  let generation = 0;
  return {
    invalidate() {
      generation += 1;
      return generation;
    },
    beginFilter() {
      generation += 1;
      return generation;
    },
    beginApply() {
      return generation;
    },
    isCurrent(id) {
      return id === generation;
    },
    acceptDecision(id, state, decision) {
      if (id !== generation || !state || !Array.isArray(state.decisions)) return false;
      state.decisions.push(decision);
      return true;
    },
    publishFilter(id, state, result) {
      if (id !== generation || !state) return false;
      state.decisions = result.decisions;
      state.relevant = result.relevant;
      return true;
    },
  };
}
