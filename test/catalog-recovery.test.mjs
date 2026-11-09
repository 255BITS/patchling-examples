import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const pages = ['index', 'overlay', 'object3d', 'comic', 'marvis', 'count'];
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const catalog = (id, owner = 'test-owner') => ({ ok: true, json: async () => ({ data: [{ id, owned_by: owner, pricing: { prompt: 0.1, completion: 0.2 } }] }) });
function picker(page, fetch) {
  const html = readFileSync(new URL(`../${page}.html`, import.meta.url), 'utf8');
  const block = html.slice(html.indexOf('let allModels ='), html.indexOf('function modelButton'));
  const setter = html.match(/const setKey = \(k\) => \{[^\n]+\};/)[0];
  const storage = new Map(), elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, { style: {}, replaceChildren() {} });
    return elements.get(id);
  };
  return runInNewContext(`${block}\n${setter}\n({ loadModels, setKey, $ })`, {
    DEFAULT_MODEL: 'fallback', MODEL: 'fallback', APPLY: 'fallback', NANOGPT: 'https://nano-gpt.com',
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    getKey: () => storage.get('ngpt_key'), setEnv() {},
    $, document: { createElement: () => ({}) }, fetch,
  });
}

for (const page of pages) {
  test(`${page}: offline/HTTP fallback is retryable and successful catalog is cached`, async () => {
    let requests = 0;
    const api = picker(page, async () => {
      requests += 1;
      if (requests === 1) throw new Error('offline');
      if (requests === 2) return { ok: false };
      return catalog('recovered');
    });
    assert.equal((await api.loadModels())[0].id, 'fallback');
    assert.equal((await api.loadModels())[0].id, 'fallback');
    const models = await api.loadModels();
    assert.equal(models[0].id, 'recovered'); assert.equal(models[0].owned_by, 'test-owner');
    await api.loadModels(); assert.equal(requests, 3);
  });
  test(`${page}: sign-in invalidates pricing and old responses cannot overwrite the new catalog`, async () => {
    const old = deferred(); let requests = 0;
    const api = picker(page, async () => (++requests === 1 ? old.promise : catalog('new-account')));
    const first = api.loadModels(), duplicate = api.loadModels();
    assert.equal(requests, 1);
    api.$('modelpicker').style.display = 'block';
    api.$('modellist').innerHTML = 'old-account buttons';
    api.$('modelcount').textContent = 'old count';
    api.setKey('new-key');
    assert.equal(api.$('modelpicker').style.display, 'none');
    assert.equal(api.$('modellist').innerHTML, '');
    assert.equal(api.$('modelcount').textContent, '');
    assert.equal((await api.loadModels())[0].id, 'new-account');
    old.resolve(catalog('old-account')); await Promise.all([first, duplicate]);
    assert.equal((await api.loadModels())[0].id, 'new-account');
    assert.equal(requests, 2);
    api.setKey(null); await api.loadModels(); assert.equal(requests, 3);
  });
}
