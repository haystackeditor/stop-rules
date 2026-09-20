# Example inputs for docs/TUNING.md

Small changes we wrote for [docs/TUNING.md](../../docs/TUNING.md), so every score in that
file can be checked. Nothing here is copied from anyone else's code.

Each `.diff` file is a unified diff. Each `.md` file is a rules file. Score one against the
other from the root of this clone:

```bash
stop-rules score --diff examples/tuning/bar.diff --rules examples/tuning/rules-errors.md
```

One diff hunk per piece is the default cut, and that is what the command above uses. A diff
file has no file content, so it can never be cut into functions anyway: ask for
`--cut functions` on a `--diff` run and the output says it used hunks instead and why. That is
why one piece covers the whole of each file below.

| File | What it is |
|---|---|
| `bar.diff` | five small files, each one handling an error differently, for the bar section |
| `cutting.diff` | one file with three functions, one of which swallows an error |
| `cutting/notify.ts` | the same file as content, so it can be scored in `functions` mode too |
| `rules-demo.diff` | a retry helper with a narrating comment, an unused local and an unused option |
| `helper.diff` | one function that calls `fetch` and one that calls the team's helper, for the kind of rule that works |
| `rules-helper.md` | the rule that names the call to avoid and the helper to use instead |
| `layers.diff` | two handlers and two services that all query the database, for the kind of rule whose answer depends on the folder |
| `rules-layers.md` | the rule that says handlers must not touch storage and services may |
| `rules-errors.md` | the one starter rule about swallowed errors |
| `rules-with-examples.md` | the starter rule about comments, examples and all |
| `rules-terse.md` | the same idea in four words |
| `rules-linter.md` | a rule a linter should own |
| `rules-codebase.md` | a rule that needs the whole codebase to answer |
| `rules-three.md`, `rules-twelve.md` | the same change under 3 and under 12 rules, for the token count |

To score `cutting/notify.ts` in `functions` mode, which needs the file and not just the diff.
`--cut functions` is not optional here: the default is one diff hunk per piece, which would
give one piece for the whole file.

```bash
mkdir /tmp/cutting && cd /tmp/cutting
git init -q && git commit -q --allow-empty -m empty
cp /path/to/stop-rules/examples/tuning/cutting/notify.ts .
cp /path/to/stop-rules/examples/tuning/rules-errors.md .stop-rules.md
node /path/to/stop-rules/bin/stop-rules.mjs score --cut functions
```

Drop the flag to see the same file as one piece, which is what a default install does.

Scores move between model versions. The ones in `docs/TUNING.md` were last run on 20 September
2026, when the service reported `jev-1.13.0`, which is also the version that scored
`helper.diff` and `layers.diff` the day before.

A `--diff` run is the one case where Jev sees no code around the change, because a diff file has
no file content to read it from. The scratch repository runs at the bottom of this file do carry
it: 25 unchanged lines each way, or the whole function in `functions` mode. Add `--show-context`
to any `score` run to print what Jev was sent.

`layers.diff` is worth reading before you write a rule of that kind. Its last two files hold
the same function twice, once under `handlers/` and once under `services/`, so the folder is
the only thing that tells them apart. On this pair Jev used it; in the experiment behind that
section of `docs/TUNING.md`, on real handlers and services, it did not.
