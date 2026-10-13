import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const catalog = JSON.parse(read('test/fixtures/demo-models.json'));
const pages = ['index', 'overlay', 'object3d', 'comic', 'marvis', 'count'];
const declaration = (html, name) => html.match(new RegExp(`const ${name}\\s*= [^;]+;`))[0];

function settings(html, saved) {
  const helper = html.slice(html.indexOf('const storedModel ='), html.indexOf('const NANOGPT ='));
  return runInNewContext([
    declaration(html, 'DEFAULT_MODEL'), declaration(html, 'APPLY_DEFAULT'),
    declaration(html, 'PINNED'), helper,
    html.match(/let MODEL = [^;]+;/)[0], html.match(/let APPLY = [^;]+;/)[0],
    '({ MODEL, APPLY, PINNED })',
  ].join('\n'), { localStorage: { getItem: () => saved } });
}

for (const page of pages) {
  const html = read(`${page}.html`);
  test(`${page}: defaults and presets are supported, inexpensive models; custom choices survive`, () => {
    for (const saved of [null, 'xiaomi/mimo-v2.5-pro-ultraspeed', 'my/custom-model']) {
      const config = settings(html, saved);
      if (saved === 'my/custom-model') {
        assert.equal(config.MODEL, saved);
        assert.equal(config.APPLY, saved);
        continue;
      }
      assert.equal(config.MODEL, 'xiaomi/mimo-v2.6-flash');
      assert.equal(config.APPLY, config.MODEL);
      assert.equal(new Set(config.PINNED).size, config.PINNED.length);
      for (const id of [config.MODEL, config.APPLY, ...config.PINNED]) {
        const model = catalog.text[id];
        assert.ok(model, `not in the verified catalog: ${id}`);
        assert.ok(model.architecture.output_modalities.includes('text'));
        assert.ok(model.pricing.prompt <= 0.5 && model.pricing.completion <= 1);
      }
    }
  });

  test(`${page}: the actual demo client streams the selected model via chat completions`, async () => {
    const client = html.match(/function streamingCallLlm\(phase\) \{[^]*?\n\}/)[0];
    let body;
    const api = runInNewContext(`${client}\nstreamingCallLlm`, {
      NANOGPT: 'https://nano-gpt.com', TextDecoder, performance, abort: null,
      $: () => ({}), words: (s) => String(s).split(/\s+/).length,
      priceOf: () => ({}), paintUsage() {}, appendText() {},
      prog: { inDone: 0, outDone: 0, cost: 0, liveIn: 0, liveOut: 0, liveCost: 0 },
      fetch: async (url, init) => {
        assert.equal(url, 'https://nano-gpt.com/api/v1/chat/completions');
        body = JSON.parse(init.body);
        return new Response('data: {"choices":[{"delta":{"content":"diff"}}]}\n\ndata: [DONE]\n\n');
      },
    });
    const model = settings(html, null).MODEL;
    const result = await api('Generating diff')({ apiKey: 'test-key', model, messages: [{ role: 'user', content: 'edit' }] });
    assert.equal(body.model, model);
    assert.equal(body.stream, true);
    assert.equal(result.choices[0].message.content, 'diff');
  });
}

test('Picture Me fallbacks use current image-edit and text models with valid sizes', () => {
  const html = read('pictureme.html');
  const config = runInNewContext(`${declaration(html, 'FALLBACK_IMG')}\n${declaration(html, 'FALLBACK_FUSE')}\n({ FALLBACK_IMG, FALLBACK_FUSE })`);
  for (const fallback of config.FALLBACK_IMG) {
    const model = catalog.images[fallback.id];
    assert.ok(model, `not in the verified image catalog: ${fallback.id}`);
    assert.equal(model.capabilities.image_to_image, true);
    for (const size of fallback.res) assert.ok(model.resolutions.includes(size), `${fallback.id}: ${size}`);
    assert.equal(fallback.price, model.pricing.per_image[fallback.res[0]]);
  }
  for (const fallback of config.FALLBACK_FUSE) assert.ok(catalog.text[fallback.id]);
});

test('MARVIS embedded and on-disk image defaults agree and use a supported resolution', () => {
  const html = read('marvis.html');
  const config = runInNewContext(`${declaration(html, 'IMG_MODEL_DEFAULT')}\n${declaration(html, 'IMG_SIZE_DEFAULT')}\n({ model: IMG_MODEL_DEFAULT, size: IMG_SIZE_DEFAULT })`);
  const disk = JSON.parse(read('marvis/config.json')).image;
  assert.deepEqual({ ...config }, disk);
  assert.ok(catalog.images[config.model].resolutions.includes(config.size));
});

test('comic keeps its current typography model and a supported portrait size', () => {
  const html = read('comic.html');
  const config = runInNewContext(`${declaration(html, 'DEFAULT_MODEL_IMG')}\n${declaration(html, 'DEFAULT_SIZE')}\n({ model: DEFAULT_MODEL_IMG, size: DEFAULT_SIZE })`);
  assert.ok(catalog.images[config.model].resolutions.includes(config.size));
});
