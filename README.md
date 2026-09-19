# stop-rules

`stop-rules` holds your coding agent to your team's written coding rules. It is a Claude
Code Stop hook: when the agent finishes a turn, it takes the code changed since the last
check and asks [Jev](https://typesafe.ai) one yes/no question per diff chunk and rule. If
a rule is likely violated it hands the violations back to the agent so it fixes them
before you ever see them.

## Quick start

```bash
git clone <this repo> && cd stop-rules
npm install && npm run build

cd /path/to/your/project
node /path/to/stop-rules/dist/cli.js init
export TYPESAFE_API_KEY=...        # your Jev API key from TypeSafe
```

`init` writes a starter `.stop-rules.md` in your repo and merges a Stop hook entry into
`.claude/settings.json`, keeping everything already in that file. Then edit the rules so
they say what your team actually cares about.

To see it work before wiring it into the agent, make a change and run:

```bash
node /path/to/stop-rules/dist/cli.js check
```

## Writing rules

`.stop-rules.md` is Markdown. Every top-level list item is one rule. Indented lines and
nested bullets belong to the rule above them. Headings, paragraphs and code blocks are
ignored, so you can paste an existing guidelines document and keep its structure.

A good rule is one checkable sentence about code, and it says what to do instead:

```markdown
- Do not silently swallow errors. Every catch block must rethrow, return the failure to
  the caller, or log it with enough context to debug.
- Do not leave debugging output (console.log, print, dbg!) in non-test code.
- Do not weaken type safety to make an error go away: no `any`, no `as unknown as`, no
  `@ts-ignore` without a reason on the same line.
```

Rules that work less well are the vague ones ("write clean code"), the ones about things
a diff does not show ("keep the service boundaries tidy"), and the ones that need to know
your whole repository. Each chunk of the diff is judged on its own.

## How it works

1. **Snapshot.** The working tree is written to a git tree object using a temporary index,
   so your own index and staged changes are never touched. Ignored files stay ignored and
   untracked files are included.
2. **Baseline.** The snapshot is diffed against the tree from the last check, so each turn
   only pays for what changed since the previous one. The baseline only moves forward when
   the run actually finished; if Jev was unreachable, the next stop checks the same code
   again.
3. **Chunks.** The diff is split per file into chunks of at most 12,000 bytes. Lock files,
   minified bundles, snapshots, binaries and deletions are skipped.
4. **Detect.** One request per chunk asks, for every rule, whether the added lines in that
   chunk violate it. Jev answers each claim with a probability. Anything at or above the
   threshold (0.5 by default) is a violation.
5. **Localise.** For each flagged chunk and rule, a second request asks which added line
   is the one at fault, one claim per line. Up to three lines are reported. Lines with no
   letter or digit are skipped, because a line that is only a brace is not distinctive
   enough to score.
6. **Report.** The violations go to the agent as plain text: file, line, the rule, the
   line, and the score.

Two things keep this cheap. Every answer is cached in the repository's git directory,
keyed on the model, the exact claim and the exact chunk text, so a re-run of the same code
costs nothing. And every run has a hard ceiling on requests (60 by default, `--max-calls`),
counted across retries and splits; when it runs out, the work that was left is reported as
"not checked" rather than quietly dropped.

## The settings entry

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/stop-rules/dist/cli.js\" hook",
            "asyncRewake": true,
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

With `"asyncRewake": true` the hook runs in the background and never delays the turn. A
clean run is silent; a run that finds violations wakes the agent with the report.

Leave `asyncRewake` out and the hook is synchronous: the stop is blocked for about a
second while the check runs, and the agent fixes the violations before the turn ends. The
code path is the same either way.

`stop-rules hook` takes `--agent <name>`, which selects how the hook payload is read and
how the result is delivered. Claude Code is the only agent implemented today and is the
default.

## check, for CI and pre-commit

`stop-rules check` runs the same pipeline and prints to stdout. It exits 0 when clean, 2
when it finds violations and 1 when it could not run at all, so it works as a pre-commit
hook or a CI step:

```bash
stop-rules check --base origin/main          # everything since the branch point
stop-rules check --base HEAD --json          # machine readable
```

Without `--base` it uses the same incremental baseline as the hook, but it never moves it
and never marks a finding as delivered, so it is safe to run repeatedly.

## What leaves your machine, and what stays

Sent to Jev, per request: one chunk of your diff, the path of the file it came from, and
the text of your rules. Nothing else. No repository name, no history, no files that the
diff does not touch.

Kept locally in `<git dir>/stop-rules/`, never committed: `state.json` (the baseline tree
and which findings were already delivered), `cache.json` (claim hashes and their scores),
`run.log` (one JSON line per run with counts and timings, capped at 1 MB) and `lock`. The
API key is only read from the environment. It is never written to disk and never appears
in output or logs.

## Limitations

- You need a Jev API key from TypeSafe. There is no offline mode.
- Each diff chunk is judged on its own, so rules about cross-file architecture, naming
  consistency across a codebase or anything needing the whole repository are weak.
- Claude Code is the only supported agent today.
- In `claude -p` (print mode) background hooks are killed when the process exits, so use
  the synchronous form there: drop `asyncRewake` from the settings entry.
- The check looks at added lines. A rule about something that was deleted, such as a test
  being removed, is only seen when the same change also adds lines to that file.

## License

MIT
