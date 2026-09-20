# Example inputs for docs/TUNING.md

Small changes we wrote for [docs/TUNING.md](../../docs/TUNING.md), so every score in that
file can be checked. Nothing here is copied from anyone else's code.

Each `.diff` file is a unified diff. Each `.md` file is a rules file. Score one against the
other from the root of this clone:

```bash
stop-rules score --diff examples/tuning/bar.diff --rules examples/tuning/rules-errors.md
```

A diff file has no file content to parse, so it is always cut by diff hunk. That is why one
piece covers the whole of each file below.

| File | What it is |
|---|---|
| `bar.diff` | five small files, each one handling an error differently, for the bar section |
| `cutting.diff` | one file with three functions, one of which swallows an error |
| `cutting/notify.ts` | the same file as content, so it can be scored in `functions` mode too |
| `rules-demo.diff` | a retry helper with a narrating comment, an unused local and an unused option |
| `rules-errors.md` | the one starter rule about swallowed errors |
| `rules-with-examples.md` | the starter rule about comments, examples and all |
| `rules-terse.md` | the same idea in four words |
| `rules-linter.md` | a rule a linter should own |
| `rules-codebase.md` | a rule that needs the whole codebase to answer |
| `rules-three.md`, `rules-twelve.md` | the same change under 3 and under 12 rules, for the token count |

To score `cutting/notify.ts` in `functions` mode, which needs the file and not just the diff:

```bash
mkdir /tmp/cutting && cd /tmp/cutting
git init -q && git commit -q --allow-empty -m empty
cp /path/to/stop-rules/examples/tuning/cutting/notify.ts .
cp /path/to/stop-rules/examples/tuning/rules-errors.md .stop-rules.md
node /path/to/stop-rules/bin/stop-rules.mjs score
```

Scores move between model versions. The ones in `docs/TUNING.md` are from 19 September 2026,
when the service reported `jev-1.13.0`.
