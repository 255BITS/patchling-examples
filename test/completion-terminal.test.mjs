import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const pages = ['index', 'overlay', 'object3d', 'comic', 'marvis', 'count'];
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
const delta = frame({ choices: [{ delta: { content: 'diff prefix' } }] });
function harness(page, chunks, error, stallCancel = false) {
  const html = readFileSync(new URL(`../${page}.html`, import.meta.url), 'utf8');
  const parser = html.match(/async function readCompletionStream\([^]*?\n\}/)[0];
  const client = html.match(/function streamingCallLlm\(phase\) \{[^]*?\n\}/)[0];
  const chat = page === 'marvis' ? html.match(/async function streamCompletion\([^]*?\n\}/)[0] : '';
  const state = { requests: 0, cancelled: 0, released: 0, signal: null };
  const prog = { inDone: 0, outDone: 0, cost: 0, liveIn: 0, liveOut: 0, liveCost: 0 };
  let at = 0;
  const context = {
    NANOGPT: 'https://example.test', TextDecoder, performance, abort: null, prog,
    $: () => ({}), priceOf: () => ({ prompt: 1, completion: 1 }),
    words: (text) => String(text).split(/\s+/).length,
    paintUsage() {}, appendText() {},
    fetch: async (_url, init) => {
      state.requests += 1; state.signal = init.signal;
      return { ok: true, body: { getReader: () => ({
        async read() {
          if (at < chunks.length) return { value: new TextEncoder().encode(chunks[at++]), done: false };
          if (error) throw error;
          return { done: true };
        },
        async cancel() { state.cancelled += 1; if (stallCancel) return new Promise(() => {}); },
        releaseLock() { state.released += 1; },
      }) } };
    },
  };
  const api = runInNewContext(`${parser}\n${client}\n${chat}\n({ streamingCallLlm${chat ? ', streamCompletion' : ''} })`, context);
  return { api, state, prog };
}
const options = { apiKey: 'test-key', model: 'test-model', messages: [{ role: 'user', content: 'edit' }] };

for (const page of pages) {
  test(`${page}: truncated SSE rejects without retry or committing live cost estimates`, async () => {
    const h = harness(page, [delta]);
    await assert.rejects(h.api.streamingCallLlm('Generating diff')(options), { name: 'IncompleteCompletionError' });
    assert.equal(h.state.requests, 1);
    assert.equal(h.state.cancelled, 1); assert.equal(h.state.released, 1);
    assert.equal(h.prog.liveIn, 0); assert.equal(h.prog.liveOut, 0); assert.equal(h.prog.liveCost, 0);
    assert.equal(h.prog.inDone, 0); assert.equal(h.prog.outDone, 0);
  });
  test(`${page}: length-limited response fails even with DONE`, async () => {
    const h = harness(page, [delta, frame({ choices: [{ delta: {}, finish_reason: 'length' }] }) + 'data: [DONE]\n\n']);
    await assert.rejects(h.api.streamingCallLlm('Generating diff')(options), { name: 'IncompleteCompletionError' });
    assert.equal(h.state.requests, 1); assert.equal(h.state.released, 1);
  });
  test(`${page}: final stop without a trailing newline is complete and keeps pricing`, async () => {
    const h = harness(page, [delta, 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], x_nanogpt_pricing: { inputTokens: 7, outputTokens: 3, costUsd: 0.01 } })]);
    const result = await h.api.streamingCallLlm('Generating diff')(options);
    assert.equal(result.choices[0].message.content, 'diff prefix');
    assert.equal(h.prog.inDone, 7); assert.equal(h.prog.outDone, 3); assert.equal(h.prog.cost, 0.01);
    assert.equal(h.state.cancelled, 1); assert.equal(h.state.released, 1);
  });
}

test('MARVIS chat rejects incomplete output and forwards its cancellation signal', async () => {
  const h = harness('marvis', [delta]);
  const controller = new AbortController();
  await assert.rejects(h.api.streamCompletion({ key: 'test-key', model: 'fake', messages: [], signal: controller.signal }), { name: 'IncompleteCompletionError' });
  assert.equal(h.state.signal, controller.signal);
  assert.equal(h.state.requests, 1); assert.equal(h.state.released, 1);
});

test('MARVIS chat preserves ordinary completed replies and streams their content', async () => {
  const h = harness('marvis', [delta, 'data: [DONE]\n\n']);
  const tokens = [];
  const result = await h.api.streamCompletion({ key: 'test-key', model: 'fake', messages: [], onDelta: (text) => tokens.push(text) });
  assert.equal(result.content, 'diff prefix');
  assert.deepEqual(tokens, ['diff prefix']);
  assert.equal(h.state.cancelled, 1); assert.equal(h.state.released, 1);
});

for (const page of pages) {
  test(`${page}: stalled transport cleanup does not hold completion pending`, { timeout: 1000 }, async () => {
    const h = harness(page, [delta, 'data: [DONE]\n\n'], null, true);
    assert.equal((await h.api.streamingCallLlm('Generating diff')(options)).choices[0].message.content, 'diff prefix');
    assert.equal(h.state.cancelled, 1); assert.equal(h.state.released, 1);
  });
}
