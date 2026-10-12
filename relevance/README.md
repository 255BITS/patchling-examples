# Relevance filter

Opt-in step in front of `generateDiff` / `smartapply` (JavaScript) and
`generate_diff` / `smartapply` (Python).

For each file, a cheap model answers “is this file relevant to the task?”
with yes or no. Only the yeses are passed on. An answer that is not a leading
standalone yes or no is kept (`failed_open`), so a muddled reply cannot drop a
file the edit needs. That fallback is not cached.

Defaults, identical in both languages:

| | |
| --- | --- |
| model | `xiaomi/mimo-v2.6-flash` |
| prompt | version 3 (path, task, and content) |
| output tokens | 1024 |
| reasoning effort | `low` (if a 4xx names the parameter, one retry without it) |
| concurrency | 8 |
| max bytes | 200000, cut on a code-point boundary |
| input tokens | 12000, counted as ceil(Unicode code points / 4) |
| retries | 2 more attempts after a timeout, 5xx, or billing-reservation error |

The cache key is a sha256 of length-prefixed UTF-8 fields, in order: prompt
version, model, output-token limit, the reasoning effort actually sent
(`low`, or empty when that parameter was omitted), task, **file path**, mode
(`full`, `truncated`, or `binary`), the preview note, and the exact body sent.
Each field is `<utf-8 byte length>:<bytes>` and a newline. A full file whose
text is `abc` does not share a key with a longer file truncated to `abc`.
Two paths never share a decision, even when the bytes match and the cache is
off. A rejected `reasoning_effort` is stored under the empty-effort key;
later lookups try `low` first, then empty. A cache read failure is a miss.
A cache write failure is logged. Neither aborts the run. A missing or
non-JSON model envelope fails open and is not cached. Valid UTF-8 bytes are
decoded to text before the call, and that text is what the result maps
forward. A leading UTF-8 BOM stays in that text. Invalid UTF-8 anywhere in
the file, including a non-empty buffer that decodes to nothing, is binary:
the model is not called, and an include policy forwards the original bytes.

Figures quoted elsewhere — Flask recall 1.0 and 0.8× overhead — are
**unverified**. This repo does not re-run that pass and does not treat those
numbers as measured results.

The other demos in this repo do not use the filter. It is a separate call
you make yourself:

```javascript
const filtered = await filterRelevant(files, task, {
  model: "xiaomi/mimo-v2.6-flash",
  maxOutputTokens: 1024,
  reasoningEffort: "low",
  callLlm: (req) => postChat(req, { apiKey, baseUrl }),
});
const diff = await generateDiff(buildEnvironment(filtered.relevant), task, opts);
const updated = await smartapply(diff, filtered.relevant, opts);
```

```python
filtered = filter_relevant(
    files,
    task,
    call_llm=post_chat,
    api_key=api_key,
    base_url=base_url,
    model="xiaomi/mimo-v2.6-flash",
    max_output_tokens=1024,
    reasoning_effort="low",
)
diff = generate_diff(build_environment(filtered["relevant"]), task, api_key=api_key)
updated = smartapply(diff, filtered["relevant"], api_key=api_key)
```

`filterRelevant` lives in `filterRelevant.js`. `filter_relevant` lives in
`filter_relevant.py`. Both take the LLM client as an argument
(`patchling`'s `callLlm` / `call_llm`) so the yes/no loop can be tested
without a network call.

## Sample projects

| id | what it is | tasks |
| --- | --- | --- |
| `shelf` | Express bookstore API | pagination, USD prices, request ids, health counts, path-not-content |
| `ink` | Python notebook CLI (stdlib only) | search by tag, markdown export, remembered notebook, reject empty notes |
| `pantry` | React recipe box | live search, detail metadata, favorites, match count in the header |

Labels are in `corpus.json`, not inside the projects, so a model that reads
the tree cannot see the answer key.

A file is relevant when a correct edit has to modify it, or would be wrong
without the symbols that file defines. Files that only share a topic are
left out. That list is the positive class. Every other file under the
project root is a negative.

`shelf` / `path-not-content` is the path-key case. `src/lib/note.js` and
`src/notes/note.js` are byte-for-byte the same, and only `src/notes/note.js`
is relevant.

```json
{
  "project": "shelf",
  "task": "request-id",
  "decisions": [
    { "path": "src/middleware/requestLog.js", "relevant": true, "answer": "yes" }
  ]
}
```

`example.js --out` and `example.py --out` write that shape. Score it with
`node relevance/benchmark.js --score run.json` or
`python relevance/example.py --score run.json`.

## Run

From the repo root. `--check` and `--dry-run` need no key and no `patchling`
install. A live run needs `patchling` and `GPTDIFF_LLM_API_KEY`.

```bash
node relevance/example.js --check
node relevance/example.js --list
node relevance/example.js --project pantry --task detail-meta --dry-run
node relevance/benchmark.js

python relevance/example.py --check
python relevance/example.py --project ink --task reject-empty --dry-run
python relevance/test_filter.py
node --test relevance/filter.test.js
node relevance/offline-check.js
```

`offline-check.js` is a syntax and import check (`node --check`, `py_compile`,
and importing `filter_relevant` and `corpus_check`). It does not call a model
and does not import patchling.

## Ignore patterns

Both languages skip the same case-insensitive globs unless `ignore` is
`false`. `**` crosses directories. `*` does not.

```
**/package-lock.json
**/yarn.lock
**/pnpm-lock.yaml
**/bun.lock
**/bun.lockb
**/npm-shrinkwrap.json
**/Cargo.lock
**/Gemfile.lock
**/poetry.lock
**/Pipfile.lock
**/composer.lock
**/go.sum
**/uv.lock
**/pdm.lock
**/flake.lock
**/pubspec.lock
**/packages.lock.json
**/Package.resolved
**/*.min.js
**/*.min.mjs
**/*.min.css
**/*.map
**/dist/**
**/build/**
**/.next/**
**/coverage/**
**/__pycache__/**
**/*.pyc
**/*.pyo
**/*.generated.*
```

The walkthrough page is `relevance.html` at the site root. Serve the repo
(`npx serve .`) so it can fetch the sample files. The repo root contains
`.nojekyll` so GitHub Pages copies the sample trees as static files, including
the Python package modules, and does not run them through Jekyll.
