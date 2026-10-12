# Relevance filter

Opt-in step in front of `generateDiff` / `smartapply` (JavaScript) and
`generate_diff` / `smartapply` (Python).

For each file, a cheap model answers “is this file relevant to the task?”
with yes or no. Only the yeses are passed on. An answer that is not a clear
yes or no is kept, so a muddled reply cannot drop a file the edit needs.

The other demos in this repo do not use the filter. It is a separate call
you make yourself:

```javascript
const filtered = await filterRelevant(files, task, { callLlm });
const diff = await generateDiff(buildEnvironment(filtered.relevant), task, opts);
const updated = await smartapply(diff, filtered.relevant, opts);
```

```python
filtered = filter_relevant(files, task, call_llm=call_llm, api_key=api_key, base_url=base_url)
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
| `shelf` | Express bookstore API | pagination, USD prices, request ids, health counts |
| `ink` | Python notebook CLI (stdlib only) | search by tag, markdown export, remembered notebook, reject empty notes |
| `pantry` | React recipe box | live search, detail metadata, favorites, match count in the header |

Labels are in `corpus.json`, not inside the projects, so a model that reads
the tree cannot see the answer key.

A file is relevant when a correct edit has to modify it, or would be wrong
without the symbols that file defines. Files that only share a topic are
left out. That list is the positive class. Every other file under the
project root is a negative.

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
```

The walkthrough page is `relevance.html` at the site root. Serve the repo
(`npx serve .`) so it can fetch the sample files. The repo root contains
`.nojekyll` so GitHub Pages copies the sample trees as static files, including
the Python package modules, and does not run them through Jekyll.
