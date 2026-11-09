import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = (page) => readFileSync(new URL(`../${page}.html`, import.meta.url), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function functionSource(html, name) {
  const match = html.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, 'm'));
  assert.ok(match, `${name} exists`);
  return match[0];
}
function stateSource(html, kind = 'PROJECT') {
  const start = html.indexOf(`/* ${kind}_RUN_STATE:START */`);
  const end = html.indexOf(`/* ${kind}_RUN_STATE:END */`);
  assert.ok(start >= 0 && end > start);
  return html.slice(start, end);
}
function listenerSource(html, id, event) {
  const start = html.indexOf(`$("${id}").addEventListener("${event}",`);
  assert.ok(start >= 0, `${id}/${event} exists`);
  const rest = html.slice(start);
  const firstLine = rest.slice(0, rest.indexOf('\n'));
  return firstLine.endsWith(');') ? firstLine : rest.slice(0, rest.indexOf('\n});') + 4);
}
function ui() {
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', textContent: '', innerHTML: '', disabled: false, checked: false,
      style: {}, files: [], handlers: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(event, callback) { this.handlers[event] = callback; },
      emit(event, value = { target: this }) { return this.handlers[event]?.(value); },
      appendChild() {}, replaceChildren() {}, focus() {},
    });
    return nodes.get(id);
  };
  return { $, document: { querySelector: $ } };
}

function project(page, options = {}) {
  const html = read(page), elements = ui(), storage = new Map();
  const generated = deferred(), applyStarted = deferred();
  const requests = { generate: [], apply: [], chat: [] };
  const prompts = [];
  const timers = new Map(); let timerId = 0;
  const fixture = {
    'scene.js': 'old scene', 'notes.txt': 'original notes', 'chat.md': 'old chat',
    'portrait.md': 'portrait', 'soul.md': 'soul', 'mood.md': 'mood', 'memory.md': 'memory',
  };
  const seed = { 'chat.md': 'fresh chat', 'mood.md': 'fresh mood', 'memory.md': 'fresh memory' };
  let api;
  const context = {
    ...elements, performance, AbortController,
    setInterval: () => 1, clearInterval() {},
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    prompt: () => prompts.shift(), confirm: () => true,
    MODEL: 'diff-model', APPLY: 'apply-model', NAME: 'MARVIS',
    CONFIG_FILES: new Set(), EMBEDDED_SEED: seed, LS_KEY: 'test-save',
    currentImage: null, IMG_MODEL: 'image-model', IMG_SIZE: 'size',
    imageCache: {}, faceStats: { count: 0, cost: 0, exact: true }, lastBalance: null,
    localStorage: { setItem: (key, value) => storage.set(key, value) },
    getKey: () => 'test-key', prog: { inDone: 0, outDone: 0, cost: 0, liveIn: 0, liveOut: 0, liveCost: 0 },
    paintUsage() {}, streamingCallLlm: () => async () => {}, callLlmForApply() {},
    buildEnvironment: (map) => ({ ...map }),
    generateDiff: async (map, goal, opts) => {
      requests.generate.push({ map, goal, opts }); generated.resolve();
      return options.generate ? options.generate(map, goal, opts) : 'diff';
    },
    parseDiffPerFile: () => [['scene.js', 'diff']], renderDiff() {},
    smartapply: async (diff, map, opts) => {
      requests.apply.push({ diff, map: { ...map }, opts }); applyStarted.resolve();
      return options.apply ? options.apply(diff, map, opts) : { ...map, 'scene.js': 'updated scene' };
    },
    renderTabs() {}, refreshPreview() {}, refreshPromptPreview() {}, renderComic() {},
    hasRendered: false, showChanges() {}, scheduleLive() {}, isPanel: () => false,
    applyStyle() {}, applyConfig() {}, renderChat() {}, updateMood() {}, thinking() {},
    toast() {}, userLabel: () => 'YOU', liveBubble: () => ({}),
    para: (value) => value, esc: (value) => value,
    chatSystemPrompt: () => 'persona', chatToMessages: () => [], showChatCost() {},
    streamCompletion: async (req) => {
      requests.chat.push(req);
      return options.chat ? options.chat(req) : { content: 'new reply', pricing: {} };
    },
    composeGoal: (goal) => goal, portraitPrompt: () => 'portrait',
    promptHash: async () => 'hash', genFace: async () => ({ url: 'new-face', cost: 0, exact: true }),
    showFace() {}, idleFaceStatus() {}, setFaceStatus() {}, faceLoading() {},
  };
  elements.$('editor').value = fixture['scene.js'];
  elements.$('goal').value = 'change scene'; elements.$('direction').value = 'change persona';
  const marvis = page === 'marvis';
  const names = ['selectFile', 'loadEditor', 'addFile', 'deleteFile', 'run'];
  if (marvis) names.push('appendChat', 'sendChat', 'filesNow', 'snapshot', 'persist', 'loadState', 'renderFace');
  const code = [
    `let files = ${JSON.stringify(fixture)}, active = 'scene.js', undoSnapshot = null;`,
    'let curPhase = "", persistTimer = null, faceToken = 0, faceNonce = 0;',
    'const fileOrder = () => Object.keys(files);',
    stateSource(html), ...names.map((name) => functionSource(html, name)),
    listenerSource(html, 'editor', 'input'), listenerSource(html, 'undo', 'click'),
    ...(marvis ? [listenerSource(html, 'clearbtn', 'click'), listenerSource(html, 'loadfile', 'change')] : []),
    `({ ${names.join(', ')}, state: () => ({ files: { ...files }, undo: undoSnapshot && { ...undoSnapshot }, applying, revision: projectRevision${marvis ? ', chatRunning' : ''} }) })`,
  ].join('\n');
  api = runInNewContext(code, context);
  return {
    ...elements, context, api, requests, storage, generated, applyStarted,
    add(path) { prompts.push(path); api.addFile(); },
    edit(path, text) { api.selectFile(path); elements.$('editor').value = text; elements.$('editor').emit('input'); },
    undo() { elements.$('undo').emit('click'); },
    saved() { return storage.has('test-save') ? JSON.parse(storage.get('test-save')).files : undefined; },
  };
}

for (const page of ['overlay', 'object3d', 'comic', 'marvis']) {
  test(`${page}: a valid apply publishes and undo restores the input`, async () => {
    const h = project(page);
    await h.api.run();
    assert.equal(h.api.state().files['scene.js'], 'updated scene');
    assert.equal(h.$('editor').value, 'updated scene');
    assert.equal(h.$('undo').disabled, false);
    h.undo();
    assert.equal(h.api.state().files['scene.js'], 'old scene');
    assert.equal(h.$('undo').disabled, true);
  });

  test(`${page}: edits during generation skip the stale apply entirely`, async () => {
    const finish = deferred(), h = project(page, { generate: () => finish.promise });
    const pending = h.api.run(); await h.generated.promise;
    h.edit('notes.txt', 'manual edit'); h.add('manual.txt');
    finish.resolve('diff'); await pending;
    assert.equal(h.requests.apply.length, 0);
    assert.equal(h.api.state().files['notes.txt'], 'manual edit');
    assert.ok('manual.txt' in h.api.state().files);
    assert.match(h.$('changes').textContent, /Kept your newer edits/);
    assert.equal(h.api.state().applying, false);
  });

  test(`${page}: stale apply cannot replace edits, additions, or deletions`, async () => {
    const finish = deferred();
    const h = project(page, { apply: async (_diff, map) => {
      const result = { ...map, 'scene.js': 'stale scene' }; await finish.promise; return result;
    } });
    const pending = h.api.run(); await h.applyStarted.promise;
    h.edit('notes.txt', 'manual edit'); h.add('manual.txt'); h.api.deleteFile('scene.js');
    await h.api.run(); // A second invocation while pending cannot start another call.
    finish.resolve(); await pending;
    const state = h.api.state();
    assert.equal(state.files['notes.txt'], 'manual edit');
    assert.ok('manual.txt' in state.files); assert.equal(state.files['scene.js'], undefined);
    assert.equal(h.requests.generate.length, 1); assert.equal(h.requests.apply.length, 1);
    assert.equal(h.requests.apply[0].map['notes.txt'], 'original notes');
    assert.equal(state.undo, null); h.undo();
    assert.equal(h.api.state().files['notes.txt'], 'manual edit');
  });

  test(`${page}: manual changes after success invalidate undo`, async () => {
    const h = project(page); await h.api.run();
    h.edit('notes.txt', 'keep after apply'); h.add('new.txt'); h.undo();
    assert.equal(h.api.state().files['scene.js'], 'updated scene');
    assert.equal(h.api.state().files['notes.txt'], 'keep after apply');
    assert.ok('new.txt' in h.api.state().files); assert.equal(h.$('undo').disabled, true);
  });

  test(`${page}: changing only the selected tab does not discard a valid run`, async () => {
    const finish = deferred(), h = project(page, { generate: () => finish.promise });
    const pending = h.api.run(); await h.generated.promise;
    h.api.selectFile('notes.txt');
    h.context.MODEL = 'new-diff-model'; h.context.APPLY = 'new-apply-model';
    finish.resolve('diff'); await pending;
    assert.equal(h.api.state().files['scene.js'], 'updated scene');
    assert.equal(h.requests.generate[0].opts.model, 'diff-model');
    assert.equal(h.requests.apply[0].opts.model, 'apply-model');
  });

  test(`${page}: a failed request restores controls and retains a still-valid undo`, async () => {
    let calls = 0;
    const h = project(page, { generate: async () => {
      if (++calls === 2) throw new Error('temporary provider failure');
      return 'diff';
    } });
    await h.api.run(); await h.api.run();
    assert.equal(h.api.state().applying, false);
    assert.equal(h.$('run').disabled, false); assert.equal(h.$('undo').disabled, false);
    assert.match(h.$('changes').textContent, /temporary provider failure/);
    assert.equal(h.api.state().files['scene.js'], 'updated scene');
    h.undo(); assert.equal(h.api.state().files['scene.js'], 'old scene');
  });
}

test('MARVIS: clear aborts a pending reply and late callbacks cannot repopulate the save', async () => {
  const reply = deferred(), h = project('marvis', { chat: () => reply.promise });
  h.$('chatinput').value = 'old question'; const pending = h.api.sendChat();
  assert.equal(h.requests.chat.length, 1);
  h.$('clearbtn').emit('click');
  assert.equal(h.requests.chat[0].signal.aborted, true);
  const saved = h.saved(); assert.equal(saved['chat.md'], 'fresh chat');
  h.requests.chat[0].onDelta('late chunk');
  reply.resolve({ content: 'late reply', pricing: {} }); await pending;
  assert.equal(h.api.state().files['chat.md'], 'fresh chat');
  assert.equal(h.saved()['chat.md'], 'fresh chat');
});

test('MARVIS: an old reply finalizer cannot enable Send during a newer reply', async () => {
  const first = deferred(), second = deferred(); let call = 0;
  const h = project('marvis', { chat: () => (++call === 1 ? first.promise : second.promise) });
  h.$('chatinput').value = 'old question'; const old = h.api.sendChat();
  h.$('clearbtn').emit('click');
  h.$('chatinput').value = 'new question'; const current = h.api.sendChat();
  first.resolve({ content: 'old reply', pricing: {} }); await old;
  assert.equal(h.$('send').disabled, true); assert.equal(h.api.state().chatRunning, true);
  second.resolve({ content: 'new reply', pricing: {} }); await current;
  assert.match(h.api.state().files['chat.md'], /fresh chat[^]*new question[^]*new reply/);
  assert.doesNotMatch(h.api.state().files['chat.md'], /old reply/);
  assert.equal(h.$('send').disabled, false);
});

test('MARVIS: loading a save invalidates the pending chat and persona result', async () => {
  const reply = deferred(), apply = deferred();
  const h = project('marvis', { chat: () => reply.promise, apply: async (_diff, map) => {
    const result = { ...map, 'scene.js': 'stale scene' }; await apply.promise; return result;
  } });
  const pendingApply = h.api.run(); await h.applyStarted.promise;
  h.$('chatinput').value = 'old question'; const pendingChat = h.api.sendChat();
  h.api.loadState({ files: { 'soul.md': 'loaded soul', 'chat.md': 'loaded chat' } });
  apply.resolve(); reply.resolve({ content: 'old reply', pricing: {} });
  await Promise.all([pendingApply, pendingChat]);
  assert.equal(h.api.state().files['soul.md'], 'loaded soul');
  assert.equal(h.api.state().files['scene.js'], undefined);
  assert.equal(h.api.state().files['chat.md'], 'loaded chat');
  assert.equal(h.requests.chat[0].signal.aborted, true);
});

test('MARVIS: an old persona finalizer cannot enable Run during a newer request', async () => {
  const first = deferred(), second = deferred(), newApply = deferred(); let call = 0;
  const h = project('marvis', { apply: async (_diff, map) => {
    const current = ++call;
    const result = { ...map, 'scene.js': current === 1 ? 'old persona result' : 'new persona result' };
    if (current === 2) newApply.resolve();
    await (current === 1 ? first.promise : second.promise);
    return result;
  } });
  const older = h.api.run(); await h.applyStarted.promise;
  h.$('clearbtn').emit('click');
  h.$('direction').value = 'new direction'; const newer = h.api.run(); await newApply.promise;
  first.resolve(); await older;
  assert.equal(h.$('run').disabled, true); assert.equal(h.api.state().applying, true);
  second.resolve(); await newer;
  assert.equal(h.api.state().files['scene.js'], 'new persona result');
  assert.equal(h.api.state().files['chat.md'], 'fresh chat');
  assert.equal(h.$('run').disabled, false);
});

test('MARVIS: editing chat by hand invalidates a pending reply without losing the edit', async () => {
  const reply = deferred(), h = project('marvis', { chat: () => reply.promise });
  h.$('chatinput').value = 'old question'; const pending = h.api.sendChat();
  h.edit('chat.md', 'my manual conversation');
  reply.resolve({ content: 'old reply', pricing: {} }); await pending;
  h.api.persist();
  assert.equal(h.saved()['chat.md'], 'my manual conversation');
  assert.equal(h.requests.chat[0].signal.aborted, true);
});

test('MARVIS: a valid persona apply and undo preserve concurrent conversation', async () => {
  const finish = deferred(), h = project('marvis', { apply: async (_diff, map) => {
    const result = { ...map, 'scene.js': 'new persona' }; await finish.promise; return result;
  } });
  const pending = h.api.run(); await h.applyStarted.promise;
  h.$('chatinput').value = 'hello'; await h.api.sendChat();
  const conversation = h.api.state().files['chat.md'];
  finish.resolve(); await pending;
  assert.equal(h.api.state().files['scene.js'], 'new persona');
  assert.equal(h.api.state().files['chat.md'], conversation);
  h.undo(); assert.equal(h.api.state().files['scene.js'], 'old scene');
  assert.equal(h.api.state().files['chat.md'], conversation);
});

test('MARVIS: clear cancels a portrait that is still hashing before its request', async () => {
  const hash = deferred(), h = project('marvis'); let requests = 0;
  h.context.promptHash = () => hash.promise;
  h.context.genFace = async () => { requests += 1; return { url: 'old face' }; };
  const pending = h.api.renderFace(); h.$('clearbtn').emit('click'); hash.resolve('hash');
  await pending; assert.equal(requests, 0);
});

test('MARVIS: only the most recent asynchronous save load may publish', async () => {
  const first = deferred(), second = deferred(), h = project('marvis');
  const input = h.$('loadfile'), a = { text: () => first.promise }, b = { text: () => second.promise };
  input.files = [a]; const older = input.emit('change');
  input.files = [b]; const newer = input.emit('change');
  second.resolve(JSON.stringify({ files: { 'soul.md': 'new save', 'chat.md': 'new chat' } })); await newer;
  first.resolve(JSON.stringify({ files: { 'soul.md': 'old save', 'chat.md': 'old chat' } })); await older;
  assert.equal(h.api.state().files['soul.md'], 'new save');
  assert.equal(h.api.state().files['chat.md'], 'new chat');
});

test('MARVIS: manual edits invalidate an asynchronous save load', async () => {
  const finish = deferred(), h = project('marvis'), input = h.$('loadfile');
  input.files = [{ text: () => finish.promise }]; const pending = input.emit('change');
  h.edit('notes.txt', 'new manual edit');
  finish.resolve(JSON.stringify({ files: { 'soul.md': 'old imported state' } })); await pending;
  assert.equal(h.api.state().files['notes.txt'], 'new manual edit');
});

test('MARVIS: discarded requests restore the submitted direction without replacing a newer one', async () => {
  for (const nextDirection of ['', 'my next direction']) {
    const finish = deferred(), h = project('marvis', { generate: () => finish.promise });
    const pending = h.api.run(); await h.generated.promise;
    h.edit('notes.txt', 'new edit'); h.$('direction').value = nextDirection;
    finish.resolve('diff'); await pending;
    assert.equal(h.$('direction').value, nextDirection || 'change persona');
  }
});

function single(options = {}) {
  const html = read('index'), elements = ui(), generated = deferred(), applyStarted = deferred();
  const requests = { generate: [], apply: [] };
  const context = {
    ...elements, performance, getKey: () => 'test-key', MODEL: 'diff-model', APPLY: 'apply-model',
    setInterval: () => 1, clearInterval() {}, paintUsage() {}, updatePlayState() {}, renderVersions() {},
    prog: {}, buildEnvironment: (map) => map, parseDiffPerFile: () => [['file.txt', 'diff']],
    streamingCallLlm: () => async () => {}, callLlmForApply() {}, renderDiff() {},
    generateDiff: async (_env, goal, opts) => { requests.generate.push({ goal, opts }); generated.resolve(); return options.generate ? options.generate() : 'diff'; },
    smartapply: async (_diff, map, opts) => { requests.apply.push({ opts }); applyStarted.resolve(); return options.apply ? options.apply(map) : { ...map, 'file.txt': 'new content' }; },
  };
  elements.$('path').value = 'file.txt'; elements.$('content').value = 'original'; elements.$('goal').value = 'original goal';
  const code = [stateSource(html, 'SINGLE'),
    'let curPhase = "", versions = [{ content: "original" }, { content: "older version" }], curVer = 0;',
    ...['run', 'selectVersion', 'pushVersion'].map((name) => functionSource(html, name)),
    listenerSource(html, 'content', 'input'), listenerSource(html, 'path', 'input'),
    '({ run, selectVersion, state: () => ({ versions, applying }) })',
  ].join('\n');
  return { ...elements, context, requests, generated, applyStarted, api: runInNewContext(code, context) };
}

test('single-file demo: editing during generation skips the stale apply', async () => {
  const finish = deferred(), h = single({ generate: () => finish.promise });
  const pending = h.api.run(); await h.generated.promise;
  h.$('content').value = 'manual content'; h.$('content').emit('input');
  finish.resolve('diff'); await pending;
  assert.equal(h.$('content').value, 'manual content'); assert.equal(h.requests.apply.length, 0);
});

test('single-file demo: switching history while applying keeps the selected version', async () => {
  const finish = deferred(), h = single({ apply: async (map) => { await finish.promise; return { ...map, 'file.txt': 'stale content' }; } });
  const pending = h.api.run(); await h.applyStarted.promise; h.api.selectVersion(1);
  finish.resolve(); await pending;
  assert.equal(h.$('content').value, 'older version'); assert.equal(h.api.state().versions.length, 2);
});

test('single-file demo: successful history entry records the submitted goal', async () => {
  const finish = deferred(), h = single({ generate: () => finish.promise });
  const pending = h.api.run(); await h.generated.promise; h.$('goal').value = 'next goal';
  h.context.APPLY = 'next apply model'; finish.resolve('diff'); await pending;
  assert.equal(h.$('content').value, 'new content');
  assert.equal(h.api.state().versions.at(-1).goal, 'original goal');
  assert.equal(h.requests.apply[0].opts.model, 'apply-model');
});
