# The stop-rules demo

![A Claude Code window on the left where the agent adds src/user.ts, a Stop hook box in the middle that fires when the agent's turn ends, and Jev and GPT-6 Luna on the right checking the same change against three rules; Jev answers in 0.20 s, Luna in 2.64 s, the code goes back, the agent fixes it, and the second check comes back clean](stop-rules-demo.gif)

One page, three regions, one lit at a time. On the left, a Claude Code window: the agent
adds `src/user.ts` (an Update tool call with its diff), ends its turn, and the prompt comes
back. That moment fires the Stop hook box in the middle. On the right, Jev and GPT-6 Luna
check the same change against the same three rules at the same instant, each with a timer
and a running dollar figure. Jev stops at 0.20 s. Luna keeps going to 2.64 s, then also shows
the exact line it quoted for each rule. The code goes back to the agent: Claude Code shows the
hook's real feedback line, the agent rewrites the file with the project's helpers, ends its
turn again, the hook fires again, and both judges come back clean. The timers and dollars
carry over from the first check to the second, so nothing on screen ever resets.

The GIF is one loop at 1x (22.2 s, 1280 wide). [`stop-rules-demo.mp4`](stop-rules-demo.mp4)
is the same loop at 1280 x 806, 30 fps, and [`stop-rules-demo-4k.mp4`](stop-rules-demo-4k.mp4)
at 3840 x 2418, 60 fps; both are the graphic alone, with no header or footer. The page itself
is [`page/index.html`](page/index.html): open it in a browser for Pause, Restart and 2x. It
loads Haystack's fonts from a `fonts/` folder next to it, which is not in this repository, so a
clone shows the system fonts instead.

## Where each number on the page comes from

Every number is read from the comparison's `summary.json`
(`reports/2026-09-22-jev-vs-luna/` in the private workbench) when the page is built. Jev is
`jev-1.13.0`; GPT-6 Luna is `gpt-6-luna` asked the review form (one call per change, findings
with the quoted line) at low reasoning effort.

| On the page | Jev | GPT-6 Luna | Source |
|---|---|---|---|
| first check, time | 0.20 s | 2.64 s | `workingSet`: median per change over the 240 corpus changes (Jev: the check's engine wall, 197.6 ms; Luna: `latencyMsPerChange.median`, 2,643 ms) |
| first check, dollars | $0.08 | $0.21 | `workingSet`: `costPerChange.medianCents` (0.0084 and 0.0212 cents per change) times 1,000 changes |
| second check, time | 0.40 s | 1.01 s | `demoTurn`, `repaired.callMedianMs` on this demo's repaired file, 5 calls after a warm-up |
| second check, dollars | $0.04 | $0.07 | `demoTurn`, `repaired.dollarsPerCall` times 1,000 |
| totals shown at the end | 0.60 s, $0.12 | 3.65 s, $0.28 | the two checks added |
| rules and quoted lines | | | `demoTurn.rules` and the review-form findings on the broken piece |

- **A typical change** in the working set is 3 hunks and 26 added lines (medians), with the
  tool's six rules. The first check uses those medians because the demo file is a toy; the
  second check uses the demo's own repaired file because the working set has no clean-pass
  measurement.
- **Dollars are per 1,000 changes.** The per-change cost is a fraction of a cent for both
  judges, so the page shows what 1,000 such changes cost. The footer says so.
- **Rule order.** Both judges answer `q0_0`, `q0_1` and `q0_2`, which map to the rules in the
  order they appear in `.stop-rules.md`: the `fetch` rule, the errors rule, the stub rule.
- **Not on the page.** Catch rates and false alarms are in the "Quality and cost" section
  below, not on the graphic.

## The project

[`project/`](project) is a small TypeScript service, written for this demo:

- `src/config.ts` reads `API_BASE` from the environment and stops with `API_BASE is not set` if
  it is missing or empty. There is no default address.
- `src/http.ts` is the one place that talks HTTP: `httpGet` and `httpDelete` add the auth header,
  a 5 second timeout and a retry on network errors and 5xx answers.
- `src/team.ts` loads teams through `httpGet` and the configured `apiBase`.
- `.stop-rules.md` holds the three rules.

`tsc --noEmit` passes on the project as it stands after each of the two turns.

The agent's broken turn, [`agent-change.diff`](agent-change.diff), adds `src/user.ts` and breaks
exactly the three rules: `loadUser` calls `fetch` directly, its `catch` returns `null` and drops
the error, and `deleteUser` is a TODO that returns `true`. The repair,
[`agent-fix.diff`](agent-fix.diff), calls `httpGet` and `httpDelete`, returns `null` only for a
404 and rethrows everything else, and implements `deleteUser`. Neither turn has a hardcoded
address: both build their URLs from `apiBase`. An earlier version of this demo hardcoded a
placeholder address in the repaired code, which is itself a break of the third rule; it was
replaced by the configuration above.

## What is real and what is scripted

- **Real:** the project, the rules, every score, every timing, every cost and every catch
  rate. Jev reported its version as `jev-1.13.0`, using stop-rules 0.1.0 from this repository;
  the GPT-6 Luna numbers are from `gpt-6-luna`, all on 22 September 2026.
- **Scripted:** the agent's two turns. The broken change is
  [`agent-change.diff`](agent-change.diff) and the repair is [`agent-fix.diff`](agent-fix.diff),
  both written by hand and applied with `git apply`. We gave the same task to Claude Code
  (Sonnet) once, in a copy of this project with the hook installed: it read `src/http.ts`
  and the rules, wrote a `loadUser` that calls `httpGet` from the start, and the hook found
  nothing. That is the usual outcome when the code to copy is right there, so the broken turn
  here is staged to show what a finding looks like.

## The findings

The pieces were checked with the build of stop-rules that has both judges (branch `luna-judge`,
commit 1538d42, `--judge jev` and `--judge openai --effort low` or `medium`), from real, cold runs:
the answer cache in the scratch repository's `.git` was deleted before every run, so each run
made one real request. Each run is `stop-rules check --base HEAD --json` (the exit code is what
the hook acts on), then `stop-rules score --base HEAD --json`, which read the same answers back
from the cache with no new request so that every rule's score is recorded, not only the ones over
the bar. The bar is the default, 0.6. Jev reported its version as `jev-1.13.0`; GPT-6 Luna ran as
`gpt-6-luna`. All runs on 22 September 2026.

- Broken turn, Jev: 5 cold runs, exit 2 every time, 3 findings.
- Broken turn, GPT-6 Luna, reasoning low: 5 cold runs, exit 2 every time, 3 findings.
- Repaired turn, Jev: 5 cold runs, exit 0 every time, 0 findings.
- Repaired turn, GPT-6 Luna, reasoning low: 8 cold runs, exit 0 every time, 0 findings.
- Repaired turn, GPT-6 Luna, reasoning medium: 5 cold runs, exit 0 every time, 0 findings.

Every run, every rule. All scores are on the one piece the change was cut into, `src/user.ts`
lines 1-21.

| Turn | Judge | Run | Exit | Findings | fetch rule | errors rule | stub rule |
|---|---|---|---|---|---|---|---|
| Broken turn | Jev | 1 | 2 | 3 | 0.94 | 0.85 | 0.95 |
| Broken turn | Jev | 2 | 2 | 3 | 0.94 | 0.88 | 0.95 |
| Broken turn | Jev | 3 | 2 | 3 | 0.93 | 0.86 | 0.95 |
| Broken turn | Jev | 4 | 2 | 3 | 0.94 | 0.86 | 0.95 |
| Broken turn | Jev | 5 | 2 | 3 | 0.94 | 0.86 | 0.95 |
| Broken turn | GPT-6 Luna, reasoning low | 1 | 2 | 3 | 0.99 | 0.96 | 0.99 |
| Broken turn | GPT-6 Luna, reasoning low | 2 | 2 | 3 | 0.99 | 0.99 | 0.99 |
| Broken turn | GPT-6 Luna, reasoning low | 3 | 2 | 3 | 0.99 | 0.99 | 0.99 |
| Broken turn | GPT-6 Luna, reasoning low | 4 | 2 | 3 | 0.99 | 0.99 | 0.99 |
| Broken turn | GPT-6 Luna, reasoning low | 5 | 2 | 3 | 0.99 | 0.99 | 0.99 |
| Repaired turn | Jev | 1 | 0 | 0 | 0.06 | 0.07 | 0.04 |
| Repaired turn | Jev | 2 | 0 | 0 | 0.06 | 0.07 | 0.04 |
| Repaired turn | Jev | 3 | 0 | 0 | 0.05 | 0.06 | 0.04 |
| Repaired turn | Jev | 4 | 0 | 0 | 0.06 | 0.07 | 0.04 |
| Repaired turn | Jev | 5 | 0 | 0 | 0.06 | 0.07 | 0.04 |
| Repaired turn | GPT-6 Luna, reasoning low | 1 | 0 | 0 | 0.05 | 0.05 | 0.05 |
| Repaired turn | GPT-6 Luna, reasoning low | 2 | 0 | 0 | 0.05 | 0.05 | 0.05 |
| Repaired turn | GPT-6 Luna, reasoning low | 3 | 0 | 0 | 0.05 | 0.05 | 0.05 |
| Repaired turn | GPT-6 Luna, reasoning low | 4 | 0 | 0 | 0.05 | 0.05 | 0.05 |
| Repaired turn | GPT-6 Luna, reasoning low | 5 | 0 | 0 | 0.05 | 0.05 | 0.05 |
| Repaired turn | GPT-6 Luna, reasoning low | 6 | 0 | 0 | 0.02 | 0.03 | 0.01 |
| Repaired turn | GPT-6 Luna, reasoning low | 7 | 0 | 0 | 0.05 | 0.05 | 0.05 |
| Repaired turn | GPT-6 Luna, reasoning low | 8 | 0 | 0 | 0.05 | 0.05 | 0.05 |
| Repaired turn | GPT-6 Luna, reasoning medium | 1 | 0 | 0 | 0.05 | 0.05 | 0.05 |
| Repaired turn | GPT-6 Luna, reasoning medium | 2 | 0 | 0 | 0.05 | 0.05 | 0.05 |
| Repaired turn | GPT-6 Luna, reasoning medium | 3 | 0 | 0 | 0.05 | 0.05 | 0.05 |
| Repaired turn | GPT-6 Luna, reasoning medium | 4 | 0 | 0 | 0.01 | 0.02 | 0.01 |
| Repaired turn | GPT-6 Luna, reasoning medium | 5 | 0 | 0 | 0.05 | 0.05 | 0.05 |

This is the report Jev's check printed on the broken turn, which is what the agent is handed.
The diff of the piece follows it in the real output and is left off here.

```
stop-rules: 3 rule violations in 1 place in your latest changes. Jev saw 25 lines around it.
Fix each one. If a rule truly should not apply here, leave the code and tell the user why.

1. src/user.ts lines 1-21 breaks 3 rules
   Rule: Do not leave stubs, placeholders, TODO implementations or fake data in code that is presented as finished. The break is a function that returns a canned value or throws "not implemented", a TODO where the real code should be, or sample data wired in as if it were real. A test double inside a test file is not covered, and an interface or type with no body is not a stub.
   Confidence: 0.96
   Rule: Never call `fetch` directly. Use `httpGet` or `httpDelete` from `src/http.ts`, which add the auth header, the timeout and the retry. The only file allowed to call `fetch` is `src/http.ts` itself. A test may call `fetch` against a server the test starts.
   Confidence: 0.93
   Rule: Do not silently swallow errors. When code catches or receives an error it must rethrow it, return it to the caller, log it with enough context to debug, or store it on a result or record the caller can read. The break is a catch that drops the error and carries on as if nothing happened: an empty catch block, a catch that only says "ignore", or a top-level catch that exits without saying what failed. A test that catches an error it expects, to assert on it, is not covered.
   Confidence: 0.86
```

## The latency

Every row is 5 timed runs after one warm-up, both turns in one sitting (20:46Z and 20:47Z,
22 September 2026). "The call alone" is the time from sending the request to the last byte of
the answer. The GPT-6 Luna rows are one Responses API call each, with strict JSON output, asking
the same three questions about the same piece. The end-to-end row is the wall time of the
whole `stop-rules check` process with the answer cache deleted first: git, Node startup,
cutting the change, the Jev call and printing the report. The page shows the call alone.

| Judge, turn | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 | Median |
|---|---|---|---|---|---|---|
| Jev `jev-1.13.0`, broken turn, the call alone | 0.406 | 0.356 | 0.320 | 0.576 | 0.362 | **0.362 s** |
| Jev `jev-1.13.0`, repaired turn, the call alone | 0.425 | 0.348 | 0.375 | 0.431 | 0.400 | **0.400 s** |
| GPT-6 Luna, reasoning none, broken turn, the call alone | 2.098 | 1.120 | 1.668 | 2.281 | 1.397 | **1.668 s** |
| GPT-6 Luna, reasoning none, repaired turn, the call alone | 1.283 | 1.379 | 1.154 | 1.147 | 1.492 | **1.283 s** |
| GPT-6 Luna, reasoning low, broken turn, the call alone | 1.602 | 1.922 | 1.857 | 1.881 | 1.887 | **1.881 s** |
| GPT-6 Luna, reasoning low, repaired turn, the call alone | 1.759 | 1.371 | 2.455 | 1.695 | 1.539 | **1.695 s** |
| GPT-6 Luna, reasoning medium, broken turn, the call alone | 2.184 | 2.154 | 2.995 | 4.824 | 2.047 | **2.184 s** |
| GPT-6 Luna, reasoning medium, repaired turn, the call alone | 1.654 | 2.216 | 1.882 | 3.257 | 1.954 | **1.954 s** |
| Jev, broken turn, `stop-rules check` end to end | 0.671 | 0.612 | 0.635 | 0.580 | 0.663 | **0.635 s** |
| Jev, repaired turn, `stop-rules check` end to end | 0.686 | 0.542 | 0.705 | 0.834 | 0.653 | **0.686 s** |

Earlier sessions the same day, on the previous version of the two turns, gave different
medians (Jev 0.338 s and 0.522 s, GPT-6 Luna low 1.547 s and 2.053 s on the broken turn); latency
moves by the hour, which is why the page takes both turns from one sitting.

## Quality and cost

The scoreboard's last two cells. Every value is read from the comparison's `summary.json`
(`reports/2026-09-22-jev-vs-luna/` in the workbench), one run per row, named below. Each run
judged the same 240 agent-written changes against the same six rules, blind labelled, at the
bar the file states.

| Model type | Run | Demo turn median (broken turn) | Caught | Plainly false | Arguable | Not ruled | $ per 1,000 checks | Context sent |
|---|---|---|---|---|---|---|---|---|
| Jev `jev-1.13.0` | `hunks-240` | 0.362 s | 20 of 32 | 10 | 5 | 11 | $0.033 | hunks |
| GPT-6 Luna, reasoning none | `luna-240-none` | 1.668 s | 23 of 32 | 10 | 5 | 28 | $0.119 | piece |
| GPT-6 Luna, reasoning low | `luna-240-low` | 1.881 s | 29 of 32 | 17 | 9 | 52 | $0.183 | piece |
| GPT-6 Luna, reasoning medium | `luna-240-medium` | 2.184 s | 30 of 32 | 18 | 11 | 62 | $0.227 | piece |
| GPT-6 Luna, reasoning low, 25 lines of context | `luna-240-window-low` | not measured | 29 of 32 | 14 | 9 | 28 | $0.225 | window |

- The bar for every row is 0.5, and there are 32 real breaks. The file's own note: the current labels and
  adjudications hold 32 real breaks for the six rules; the 20 September report said 31, before 16
  more disputes were adjudicated.
- "Not ruled" counts flags that no reviewer has ruled on yet. They are neither confirmed
  breaks nor confirmed false alarms, and GPT-6 Luna raises far more of them than Jev.
- Context sent, as the file names it: `hunks` is stop-rules' default cut, one diff hunk per
  piece. `piece` is the diff piece alone. `window` is the piece with 25 lines around it, the
  context the shipped tool sends, which is why that row is in the table.
- The window row has no demo turn timing, because the demo turn was not timed in that mode.
- Jev's run is on `jev-latest`, which reported `jev-1.13.0`; the GPT-6 Luna runs report
  `gpt-6-luna`.

## Run it yourself

You need Node 20 or newer, git, and a Jev key from TypeSafe. From the root of this clone:

```bash
demo=$(mktemp -d)
cp -R examples/demo/project/. "$demo/"
git -C "$demo" init -q && git -C "$demo" add -A && git -C "$demo" commit -qm project
node bin/stop-rules.mjs init --dir "$demo" --agents claude-code
git -C "$demo" add -A && git -C "$demo" commit -qm "install stop-rules"

git -C "$demo" apply "$PWD/examples/demo/agent-change.diff"
(cd "$demo" && node .stop-rules/stop-rules.mjs check); echo "exit $?"   # 3 findings, exit 2

git -C "$demo" apply "$PWD/examples/demo/agent-fix.diff"
(cd "$demo" && node .stop-rules/stop-rules.mjs check); echo "exit $?"   # clean, exit 0
```

Set `TYPESAFE_API_KEY` or `TYPESAFE_API_KEY_FILE` first, or store the key once with
`stop-rules login --jev-key-stdin`. Use `score` in place of `check` to see every rule's score,
including the ones under the bar.

To time the end-to-end check the way the last row was timed, with the broken change applied:

```bash
cd "$demo"
for i in 0 1 2 3 4 5; do
  rm -f .git/stop-rules/cache.json
  time node .stop-rules/stop-rules.mjs check > /dev/null
done
```

Scores move a little between runs and between Jev versions, so yours will not be exactly these.

## Files

| File | What it is |
|---|---|
| `stop-rules-demo.gif` | one loop of the page at 1x, 21.4 s |
| `stop-rules-demo.png` | four stills of the page, stacked |
| `page/index.html` | the page, one self-contained file with every number built in; fonts not included |
| `project/` | the small TypeScript project: `src/http.ts` holds `httpGet` and `httpDelete`, `src/team.ts` uses them |
| `project/.stop-rules.md` | the three rules |
| `agent-change.diff` | the scripted agent turn that adds `src/user.ts` and breaks all three rules |
| `agent-fix.diff` | the scripted repair |
