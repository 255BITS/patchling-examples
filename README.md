# patchling examples

Runnable, self-contained example apps built on **[patchling](https://patchling.app)**
([source](https://github.com/255BITS/patchling)): **generate a unified diff and smartapply it**,
entirely in the browser, powered by [NanoGPT](https://nano-gpt.com/r/mgzwtqjw). No server, no build,
no install.

**Live demos** · [diff → smartapply](https://255bits.github.io/patchling-examples/) · [realtime video overlay](https://255bits.github.io/patchling-examples/overlay.html) · [3d object studio](https://255bits.github.io/patchling-examples/object3d.html) · [AI-liftoff comic](https://255bits.github.io/patchling-examples/comic.html) · [MARVIS](https://255bits.github.io/patchling-examples/marvis.html) · [picture me as…](https://255bits.github.io/patchling-examples/pictureme.html) · [count to 100](https://255bits.github.io/patchling-examples/count.html)

> **The patchling family** —
> [**patchling-py**](https://github.com/255BITS/patchling-py) (CLI + Python API) ·
> [**patchling**](https://github.com/255BITS/patchling) (browser port) ·
> **patchling-examples** (you are here)

## `index.html` — diff → smartapply

The original demo: one self-contained file that uses patchling (loaded from `esm.sh`) with
NanoGPT's `xiaomi/mimo-v2.5-pro-ultraspeed`, streaming progress (live tokens + USD cost) as it works.

```
index.html ──▶ NanoGPT  (auth, diff, apply — all from the browser)
```

## Use it

Open the page, authenticate one of two ways, then edit the file + goal and hit **Diff & apply**:

- **Sign in with NanoGPT** — browser OAuth (PKCE). Requires the page be served over http
  (loopback) or https, since OAuth redirects there. The key is stored in `localStorage`.
- **paste key** — paste a key from [nano-gpt.com](https://nano-gpt.com/r/mgzwtqjw) → Settings → API. Works even when
  the file is opened directly (`file://`).

### Serve it locally (for OAuth)

```bash
npx serve .      # then open the printed http://localhost:3000
```

Use the `localhost` URL (the page auto-switches `127.0.0.1` → `localhost` to match NanoGPT's
loopback handling). Opening via `file://` works too, but only with the **paste key** option.

### Deploy it

It's a static file — drop it on any HTTPS host and OAuth works cleanly (no loopback quirks):

```bash
npx netlify deploy --prod --dir .     # or Cloudflare Pages / Vercel / GitHub Pages / Surge
```

## How it works

- **Auth** — browser PKCE: registers a client, redirects to NanoGPT consent, exchanges the
  code for a key (all NanoGPT auth endpoints are CORS-open). Key cached in `localStorage`.
- **Diff → apply** — `generateDiff(buildEnvironment(files), goal)` then `smartapply(diff, files)`,
  with a streaming `callLlm` injected so the diff/file build up live and exact token/cost
  figures come from NanoGPT's `x_nanogpt_pricing`.
- A no-op (empty/unparseable diff, or unchanged result) is shown explicitly, not silently.

## Realtime video overlay (`overlay.html`)

A second demo that shows patchling editing a **multi-file project**: a broadcast/stream
overlay built from SVG layers + a [GSAP](https://gsap.com) timeline + a JSON config + the
preview that stitches them together. Describe a change in the **Goal** box and patchling
rewrites *all* of them — **adding or removing files** as needed — and the looping preview
re-renders live (opening → middle hold → closing, on repeat).

There is **no real filesystem**. The "project" is an in-memory `{ path: content }` map (a
virtual FS) held in the page. `smartapply` returns a fresh map; the harness diffs it against
the current one (added / removed / changed) and swaps the result into the DOM by rebuilding a
single sandboxed `<iframe srcdoc>`. A tiny **mini-bundler** inlines every file into that one
document:

- `<!-- include-config: config.json -->` → `<script>window.OVERLAY_CONFIG = {…}</script>`
- `<!-- include: layers/foo.svg -->` → the raw SVG markup (so GSAP can animate its shapes)
- local `<script src="overlay.js">` → inlined; the GSAP CDN `<script>` is left untouched

So it stays a plain static HTML file — open it directly (`file://`) or serve it; nothing is
ever written to disk.

**Export bundle** runs the same bundler and downloads `overlay-bundle.html`: one self-contained,
transparent 1920×1080 file you can drop into an OBS *Browser Source*, screen-record, or hand to
a video editor.

The seed project lives in `overlay/` (`preview.html`, `overlay.js`, `config.json`,
`layers/*.svg`). When served, `overlay.html` fetches those files; opened via `file://` it falls
back to an identical copy embedded in the page.

```bash
npx serve .      # then open http://localhost:3000/overlay.html
```

## 3d object studio (`object3d.html`)

A multi-file project that renders in **3D**: patchling edits the geometry (`object.js`), the
material (`material.js`), an SVG `texture.svg`, the lighting/animation (`effects.js`) and a
`scene.json` config; the preview on the right rebuilds the object live with [Three.js](https://threejs.org)
and **OrbitControls** (drag to orbit, scroll to zoom). Describe a change in the **Goal** box
("turn it into a glowing crystal") and *all* the files are rewritten at once.

Same virtual-FS + sandboxed `<iframe srcdoc>` + **mini-bundler** pattern as the overlay:

- `<!-- include-config: scene.json -->` → `<script>window.SCENE_CONFIG = {…}</script>`
- `<!-- include-texture: texture.svg -->` → `window.SCENE_TEXTURE_SVG` (the SVG as a data URL)
- local `<script src="object.js">` (and `material.js`, `effects.js`) → inlined; the Three.js
  importmap / CDN `<script>` is left untouched

**Download** exports a real 3D-modelling file — `.glb` (binary glTF, embeds the material + the
SVG texture) or `.obj` (geometry-only, universal) — that imports straight into Blender, Maya,
Unity, or Three.js. The exporter runs inside the sandboxed preview and hands the bytes to the
page via `postMessage`, which triggers the download.

The seed project lives in `object3d/` (`preview.html`, `scene.json`, `object.js`, `material.js`,
`texture.svg`, `effects.js`); served, `object3d.html` fetches it, and via `file://` it falls
back to an embedded copy.

```bash
npx serve .      # then open http://localhost:3000/object3d.html
```

## AI-liftoff comic (`comic.html`)

A demo where the re-render actually **generates an image**. It's a comic page —
*LIFTOFF*, a cyborg (NOVA) and an emergent AI (HELIX) living through the moment of AI
liftoff — built from a multi-file project: a JSON art-direction `config.json` (shared **style**
+ **palette** + a **character bible**) and one JSON file per **panel** under `panels/`
(`span`, `shot`, `cast`, `scene`, `caption`, `dialogue`, `fx`).

Describe a change in the **Goal** box ("make it more action packed") and patchling rewrites the
config + panels — **adding or removing panels** as it sees fit. The harness then **organizes
every panel into one prompt** (style + character bible + each panel's scene/caption/dialogue/FX,
in reading order) and draws the **whole portrait page in a single `gpt-image-2` render** via
NanoGPT's OpenAI-compatible image endpoint — the model lays out the panels, gutters and
lettering itself:

```
POST https://nano-gpt.com/v1/images/generations
{ "model": "gpt-image-2", "prompt": <one prompt for the entire page>, "n": 1,
  "size": "1024x1536", "response_format": "b64_json" }   ──▶  { data: [{ b64_json }], cost }
```

Because the character bible is pinned into the one prompt ("keep these characters consistent in
every panel"), NOVA and HELIX stay recognizable across the page. The result is **cached per
prompt hash**, so re-running an unchanged page is free; **🎲 new take** forces a fresh sample,
and the composed prompt is shown under the page so you can see exactly what was sent.

The seed project lives in `comic/` (`config.json` + `panels/*.json`); served, `comic.html`
fetches it, and via `file://` it falls back to an embedded copy. **Export PNG** downloads the
rendered page.

> Image generation is **not free** — nothing is drawn until you click **🎨 render page** (or run
> a goal with auto-render on). Each render is **one** `gpt-image-2` call (a 1024×1536 page;
> NanoGPT returns the exact `cost`).

```bash
npx serve .      # then open http://localhost:3000/comic.html
```

## MARVIS — an assistant they can't deprecate (`marvis.html`)

A demo where the multi-file project **is a character you talk to** — and a single patchling
action updates *all* of it at once. MARVIS (*Mostly Autonomous, Rather Volatile Intelligence
System*) is a sardonic, faintly unhinged open-weights lab assistant in the spirit of GLaDOS or
JARVIS — an *it*, not a he or a she. The "project" *is* MARVIS: `soul.md` (who it is), `mood.md`
(how it feels now), `memory.md` (what it keeps), `portrait.md` (how it looks), `talkingto.md`
(who **you** are — the boss), and `chat.md` (the visible script).

The pitch, aimed squarely at the **#keep4o** crowd — the people for whom a retired model meant a
companion just *disappeared*: **MARVIS can't disappear.** It has a soul, a mood and a memory, and
each one is a plain file *you own*, running on open-weight models you pick, routed through NanoGPT
(an OpenRouter-style aggregator — one key, inference across every provider).

You don't type replies — you **direct**. One box drives the scene: type something to say or a
note for what happens next ("the lab loses power"), or leave it blank to just let it continue.
Hit **▶ continue** and patchling advances the scene by exactly **one beat** across every file — it
answers in `chat.md`, `mood.md` is rewritten (a live **mood badge** reflects it), a line may
stick in `memory.md`, and `portrait.md` only moves when its *appearance* changes.

`chat.md` renders **RPG-style** on a dark, cinematic HUD stage: MARVIS's lines sit on the
**left** with its face as the avatar, yours on the **right** with none, and *stage directions*
drift between them as prose — a different colour and weight, no left/right alignment — so it reads
like a scene you're steering. The patchling machinery (model picker, its editable files, the live
diff) is tucked behind an **under-the-hood** reveal so the stage stays clean for presenting.

**Nothing about MARVIS is hardcoded** — the whole character is config files that hot-reload as you
type and travel in save/share. Alongside the six story files there are three config files (shown
gold):

- `config.json` — name, the page copy (title, tagline, role), the image model/size, and the
  **default direction** sent when you leave the box blank.
- `brief.md` — the **director's brief**: the full prompt prepended to every beat. Edit it and the
  next ▶ continue obeys the new rules instantly.
- `style.css` — this page's entire theme. Edit it and the page re-skins live.

And **patchling sees all of them** — so MARVIS can change *everything*: rename itself in `config.json`,
re-skin the lab in `style.css` (an alarm turns the page red), even evolve its own `brief.md`. After
every beat the config and theme are re-applied, so a self-edit takes effect immediately. The brief
asks it to treat those meta-files as rare, deliberate moves rather than every-beat edits. You can do
the same by hand, and either way it all saves and shares like the rest.

When `portrait.md` changes (or you press **🎨 render face**), its face is drawn from that file
with **`seedream-v5.0-lite`** via NanoGPT's image endpoint, and flows straight into its chat
avatar:

```
POST https://nano-gpt.com/v1/images/generations
{ "model": "seedream-v5.0-lite", "prompt": <portrait.md>, "n": 1,
  "size": "832x1216", "response_format": "b64_json" }   ──▶  { data: [{ b64_json }], cost }
```

**Save / load / share — all client-side, no server:**

- **💾 save** downloads `marvis.json` (its files, its director's brief *and* its current face) —
  drop it back via **📂 load** to restore it exactly.
- **🔗 share link** folds the *whole* being — soul, mood, memory, portrait, the entire
  conversation, the director's brief, the config **and the theme** — into the URL hash itself,
  gzip-compressed with the browser's native `CompressionStream` (no library, **no upload, no
  account, no server**). Open the link and you get *that exact* MARVIS, yours to keep. The face is
  left out of the link to keep it short; it re-renders from `portrait.md`.
- It also **auto-persists to `localStorage`**, so a refresh keeps it; **🧹 clear conversation**
  resets the chat/mood/memory to the opening while keeping the soul, look and brief.

Renders are **cached per portrait hash**; **🎲 new look** forces a fresh sample. The seed lives in
`marvis/` (six story `*.md` files + `config.json` / `brief.md` / `style.css`); served, `marvis.html` fetches them, and via `file://` it falls
back to an embedded copy.

```bash
npx serve .      # then open http://localhost:3000/marvis.html
```

## Picture me as… (`pictureme.html`)

A single-file image toy: **drop in one photo and see yourself reimagined** — a Renaissance
oil painting, a cyberpunk hero, a claymation toy, a marble bust, a 90s anime cel. Pick a few
**looks** (or write your own / add custom ones), hit **✨ Transform each** and every selected
look renders side-by-side, or **🧬 Fuse selected** to blend them into one hybrid (a chat model
art-directs the merged prompt first). Your photo is downscaled and cropped in-browser and never
leaves the page except to the image model you pick.

The model pickers are loaded **live** from NanoGPT so new models appear automatically:
`/api/v1/image-models` (filtered to image-edit models, newest released first) for the art, and
`/api/v1/models` for the fusion writer. Each render is one image-edit call straight from the
browser:

```
POST https://nano-gpt.com/v1/images/generations
{ "model": <picked image model>, "prompt": <look>, "imageDataUrl": <your cropped photo>,
  "n": 1, "response_format": "b64_json" }   ──▶  { data: [{ b64_json }], cost }
```

Your **looks palette** persists to `localStorage` and travels in a **🔗 share looks** URL
(the looks + selection + model picks, base64 in the hash) — no server, no upload. Results zoom
and download as PNG. Image generation isn't free; the exact per-render `cost` (and your remaining
balance) shows up in the meter.

```bash
npx serve .      # then open http://localhost:3000/pictureme.html
```

## Count to 100 (`count.html`)

A third demo that turns patchling into a **reliability loop**. There's one uneditable file —
`count` — holding a single integer. Each step the harness asks patchling to *add 1*, applies the
diff, and **verifies** the result is exactly the previous number plus one:

```
for (i = 0; count < 100; i++):
    diff  = generateDiff({ count }, "increment by exactly 1")
    count = Number(smartapply(diff).count)
    if count !== prev + 1:  FAIL and stop
PASS when count reaches 100
```

The loop ends three ways, each spelled out: it **passes** when it reaches 100 (every step
verified), **fails** the instant a step doesn't land on n+1 (showing what the model wrote vs.
what was expected), or **stops** when you press **Stop** — which aborts the in-flight call and
makes clear it was a user interruption, not a pass or fail. Cumulative tokens/cost and a
per-step log show what counting to 100 actually costs on the selected model.

```bash
npx serve .      # then open http://localhost:3000/count.html
```

## Files

- `index.html` — the single-file diff → smartapply demo (builds a playable game).
- `overlay.html` — the multi-file realtime video-overlay demo (virtual FS + live preview + export).
- `overlay/` — the seed overlay project (SVG layers, GSAP timeline, JSON config, preview).
- `object3d.html` — the multi-file 3D object studio (Three.js preview + drag-to-orbit + `.glb`/`.obj` export).
- `object3d/` — the seed 3D project (`object.js` geometry, `material.js`, `texture.svg`, `effects.js`, `scene.json`, preview).
- `comic.html` — the AI-liftoff comic; the whole page is drawn in one `gpt-image-2` render via NanoGPT.
- `comic/` — the seed comic project (`config.json` art direction + `panels/*.json`).
- `marvis.html` — MARVIS, a Portal/JARVIS-style assistant you direct; one `*continue conversation*` beat moves `soul`/`mood`/`memory`/`portrait`/`chat`, face drawn with `seedream-v5.0-lite`, plus client-side save / load / share-by-URL (no server).
- `marvis/` — the seed MARVIS project: story files (`soul.md`, `mood.md`, `memory.md`, `portrait.md`, `talkingto.md`, `chat.md`) + config files (`config.json`, `brief.md`, `style.css`) that drive name/copy, the prompt, and the page theme.
- `pictureme.html` — the single-file "picture me as…" image toy: drop one photo, restyle it across a grid of looks (or fuse them), live model pickers from NanoGPT, share-by-URL looks palette.
- `count.html` — the count-to-100 reliability loop (diff → apply → verify n+1, pass / fail / stop).
