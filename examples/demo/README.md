# The stop-rules demo

![Three panes: the change the agent wrote, the three rules with the judge's scores, and the findings sent back to the agent; the agent's second turn comes back clean](stop-rules-demo.gif)

The demo is one page with three panes that stay put while the data moves through them. On the
left is the code the agent wrote, in the middle the team's three rules, and on the right what
the stop hook hands back to the agent. In turn 1 the agent adds `src/user.ts` with a direct
`fetch`, a catch that drops the error and a TODO stub; the judge scores all three rules at or
above the 0.6 bar, and three findings go back. In turn 2 the agent rewrites the piece with the
project's `httpGet` helper, and the same three questions come back clean.

A status line under the panes says what the judge is doing, with a timer that runs at real
speed and stops at the judge's measured median. A scoreboard under it adds up the questions
asked and the seconds spent waiting, and shows the judge's cost per 1,000 checks and how many
real breaks it caught on 240 labelled agent-written changes. Buttons switch the judge between
Jev and GPT-6 Luna at three reasoning settings, and replay the same two turns with that judge's
own numbers.

The GIF above is one loop at 1x with Jev selected (20.8 s). The page itself is
[`page/index.html`](page/index.html); open it in a browser. It loads Haystack's fonts from a
`fonts/` folder next to it, which is not in this repository, so a clone shows the system fonts
instead. [`stop-rules-demo.png`](stop-rules-demo.png) is four stills of the page: turn 1
judged, turn 1 handed back, turn 2 clean, and turn 1 judged by GPT-6 Luna with medium
reasoning.

## Where each number on the page comes from

Every number is written into the page when it is built, read from these files, not typed in:

| On the page | Source |
|---|---|
| Jev's turn 1 scores, 0.94 / 0.88 / 0.96 by rule | the `stop-rules check` report on the broken change, quoted under "The findings" below |
| Jev's turn 2 scores, 0.06 / 0.07 / 0.10 | Jev's answers to `stop-rules score` on the repaired piece, 22 September 2026 |
| GPT-6 Luna's turn 1 scores | the comparison's `demo-latency.json`, the call whose time is the median for that setting |
| turn 1 timer, every judge | `demoTurn` in the comparison's `summary.json`, median of 5 calls, the call alone |
| Jev's turn 2 timer, 0.399 s | 5 timed calls to Jev on the repaired piece at 20:10Z (357.0, 570.1, 398.9, 357.7, 424.8 ms, after one warm-up), timed the same way |
| $ per 1,000 checks, real breaks caught, plainly false | the judge's run in `summary.json` (`hunks-240`, `luna-240-none`, `luna-240-low`, `luna-240-medium`), bar 0.5, 32 real breaks |

Not measured, and the page says so rather than filling it in:

- **GPT-6 Luna's turn 2.** No recorded run asked GPT-6 Luna about the repaired piece, so with a
  Luna judge selected, turn 2 shows "not measured" instead of scores, and the timer and
  scoreboard stop after turn 1.
- **The judge's rule-by-rule answer ids.** Jev and GPT-6 Luna answer `q0_0`, `q0_1`, `q0_2` in
  the order the rules appear in `.stop-rules.md`; the page maps them in that order. Jev's
  turn 2 answers confirm it: its `score` output printed the stub rule at 0.10, the error rule at
  0.07 and the `fetch` rule at 0.06, which are `q0_2`, `q0_1` and `q0_0`.

The scoreboard's catch rate is at the comparison's bar of 0.5, while the demo runs at the
tool's default of 0.6. The scoreboard says "bar 0.5" next to it.

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

All three are on the one piece the change was cut into, `src/user.ts` lines 1-21. The bar is
the default, 0.6.

| Rule | Score on the page | Range over 5 check runs | After the repair |
|---|---|---|---|
| No stubs, placeholders or TODO implementations | 0.96 | 0.96 to 0.96 | 0.10 |
| Never call `fetch` directly, use `httpGet` or `httpDelete` | 0.94 | 0.93 to 0.94 | 0.06 |
| Do not silently swallow errors | 0.88 | 0.84 to 0.88 | 0.07 |

The page names each rule in a few words so it reads at a glance. The full wording is in
[`project/.stop-rules.md`](project/.stop-rules.md), and this is the report the check printed
on the third of 5 cold-cache check runs, the one the page takes its turn 1 Jev scores from,
which is what the agent is handed. The diff of the piece follows it
in the real output and is left off here.

```
stop-rules: 3 rule violations in 1 place in your latest changes. Jev saw 25 lines around it.
Fix each one. If a rule truly should not apply here, leave the code and tell the user why.

1. src/user.ts lines 1-21 breaks 3 rules
   Rule: Do not leave stubs, placeholders, TODO implementations or fake data in code that is presented as finished. The break is a function that returns a canned value or throws "not implemented", a TODO where the real code should be, or sample data wired in as if it were real. A test double inside a test file is not covered, and an interface or type with no body is not a stub.
   Confidence: 0.96
   Rule: Never call `fetch` directly. Use `httpGet` or `httpDelete` from `src/http.ts`, which add the auth header, the timeout and the retry. The only file allowed to call `fetch` is `src/http.ts` itself. A test may call `fetch` against a server the test starts.
   Confidence: 0.94
   Rule: Do not silently swallow errors. When code catches or receives an error it must rethrow it, return it to the caller, log it with enough context to debug, or store it on a result or record the caller can read. The break is a catch that drops the error and carries on as if nothing happened: an empty catch block, a catch that only says "ignore", or a top-level catch that exits without saying what failed. A test that catches an error it expects, to assert on it, is not covered.
   Confidence: 0.88
```

The page shows lines 9 to 21 of the broken file and 11 to 22 of the repaired one. The whole
files are the two diffs.

## The latency

The turn 1 timer races the judges on the same piece of `src/user.ts` and the same three rules,
each asked the three yes or no questions at once: 5 timed runs per row, after one warm-up
run that was not counted. The page uses the second session, so every turn 1 time on it comes
from one sitting. Both sessions are here because latency moves by the hour: 47 minutes
apart, every call median was higher in the second session and the end-to-end median lower.

| Model type | Session (22 Sep 2026) | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 | Median |
|---|---|---|---|---|---|---|---|
| Jev `jev-1.13.0`, the call alone | 19:11Z | 0.338 | 0.429 | 0.400 | 0.332 | 0.329 | **0.338 s** |
| Jev `jev-1.13.0`, the call alone | 19:58Z | 0.407 | 0.579 | 0.482 | 0.564 | 0.522 | **0.522 s** |
| GPT-6 Luna, reasoning none | 19:11Z | 1.135 | 1.039 | 1.363 | 1.010 | 0.923 | **1.039 s** |
| GPT-6 Luna, reasoning none | 19:58Z | 1.665 | 1.352 | 2.565 | 2.769 | 1.571 | **1.665 s** |
| GPT-6 Luna, reasoning low | 19:11Z | 1.427 | 2.682 | 1.547 | 1.514 | 1.728 | **1.547 s** |
| GPT-6 Luna, reasoning low | 19:58Z | 1.904 | 4.729 | 1.917 | 3.621 | 2.053 | **2.053 s** |
| GPT-6 Luna, reasoning medium | 19:11Z | not measured | | | | | not measured |
| GPT-6 Luna, reasoning medium | 19:58Z | 2.695 | 2.008 | 2.339 | 4.134 | 3.684 | **2.695 s** |
| Jev, `stop-rules check` end to end | 19:11Z | 0.855 | 0.764 | 0.671 | 0.812 | 0.783 | **0.783 s** |
| Jev, `stop-rules check` end to end | 19:58Z | 0.564 | 0.668 | 0.610 | 0.634 | 0.752 | **0.634 s** |

- "The call alone" is the time from sending the request to the last byte of the answer.
- The GPT-6 Luna rows are one Responses API call each, with strict JSON output, asking the
  same three questions about the same piece.
- The end-to-end rows are the wall time of the whole check process, answer cache deleted
  first: git, Node startup, cutting the change, the Jev call and printing the report. The
  page does not show it; it is here for what a whole stop hook takes on this piece.
- This does not include the time Claude Code takes to wake the agent with the report, which
  was not measured.

## Quality and cost

The scoreboard's last two cells. Every value is read from the comparison's `summary.json`
(`reports/2026-09-22-jev-vs-luna/` in the workbench), one run per row, named below. Each run
judged the same 240 agent-written changes against the same six rules, blind labelled, at the
bar the file states.

| Model type | Run | Demo turn median | Caught | Plainly false | Arguable | Not ruled | $ per 1,000 checks | Context sent |
|---|---|---|---|---|---|---|---|---|
| Jev `jev-1.13.0` | `hunks-240` | 0.522 s | 20 of 32 | 10 | 5 | 11 | $0.033 | hunks |
| GPT-6 Luna, reasoning none | `luna-240-none` | 1.665 s | 23 of 32 | 10 | 5 | 28 | $0.119 | piece |
| GPT-6 Luna, reasoning low | `luna-240-low` | 2.053 s | 29 of 32 | 17 | 9 | 52 | $0.183 | piece |
| GPT-6 Luna, reasoning medium | `luna-240-medium` | 2.695 s | 30 of 32 | 18 | 11 | 62 | $0.227 | piece |
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
| `stop-rules-demo.gif` | one loop of the page at 1x with Jev selected, 20.8 s |
| `stop-rules-demo.png` | four stills of the page, stacked |
| `page/index.html` | the page, one self-contained file with every number built in; fonts not included |
| `project/` | the small TypeScript project: `src/http.ts` holds `httpGet` and `httpDelete`, `src/team.ts` uses them |
| `project/.stop-rules.md` | the three rules |
| `agent-change.diff` | the scripted agent turn that adds `src/user.ts` and breaks all three rules |
| `agent-fix.diff` | the scripted repair |
