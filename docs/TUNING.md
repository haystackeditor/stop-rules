# Tuning stop-rules

This file lists every knob, says what turning it does, and shows what each one cost on real
code. It does not tell you which values to pick. That is your call, and the point of this
file is to make it an informed one.

## Where the knobs live

One file, `.stop-rules.json` in your repository root. It is committed and holds no secret.
Every key is optional.

```json
{
  "endpoint": "https://stop-rules.your-team.example.com",
  "cut": "hunks",
  "threshold": 0.5,
  "maxCalls": 60
}
```

| Knob | File key | Flag | Default |
|---|---|---|---|
| Where questions go | `endpoint` | `--team <url>` on `init` | your own Jev key |
| How a change is cut into pieces | `cut` | `--cut hunks\|functions\|chunks` | `hunks` |
| The bar a score must reach | `threshold` | `--threshold <0..1>` | `0.5` |
| Requests to Jev in one run | `maxCalls` | `--max-calls <n>` | `60` |

Every default in that table was measured, and none of them is a recommendation. The two this
file spends the most words on are the cut, which is `hunks` because it parses nothing and
caught the most on the sample below, and the bar, which is `0.5` because that is what was
measured on `hunks`. Both are yours to change.

A flag beats the file. The file beats the default. A key the tool does not know, a value of
the wrong type and a value out of range each stop the run with one line that names the key.

## See the scores on your own code first

```bash
stop-rules score
```

`score` runs the same cutting and asks the same questions as `check`, applies no bar at all,
and prints every piece with every rule's score, highest first. It changes nothing: no
baseline moves and nothing is marked as checked. It is the honest way to pick a bar, because
you are looking at your code and not at ours.

`stop-rules score --diff some.diff` scores a diff file instead of the working tree. A diff
file has no file content, so it can never be cut into functions: in the default mode it is cut
into one piece per hunk, which is what was asked for anyway, and if you ask for `functions` the
output says it used hunks instead and why. It also has no lines around a change to send Jev, so
that is the one mode where Jev sees the diff alone, and the output says that too.

`stop-rules score --show-context` prints, under each piece, exactly what Jev was sent for it:
the widened diff, or the diff and the whole function. Use it whenever a score surprises you.

## About the numbers in this file

Two kinds of number appear below.

- **Measured totals** come from 240 real changes written by coding agents in 104 public
  repositories, labelled blind by reviewers and, where Jev and a reviewer disagreed in an
  earlier round, ruled on by an adjudicator. That is a small sample of other people's code.
  Your code will give you different numbers.
- **Example scores** come from the small examples in
  [`examples/tuning/`](../examples/tuning), which we wrote for this file. Every one of them
  is a real answer from the live service. The scores below were last run on 20 September 2026,
  when Jev started seeing the code around each piece; asked on that day, the service reported
  its version as `jev-1.13.0`, the same version as the runs the day before, so the movement
  between the two days is the new claim wording plus the ordinary movement between runs, and not
  a new model. The tool asks for `jev-latest`.

Two things about the numbers themselves. Scores drift between model versions, and they also
move between runs on one version. We asked the five examples below seven times, with a cold
cache each time, minutes apart. The confident answers moved by a hundredth or two. The
borderline one moved from 0.45 to 0.80. So treat every number here as the shape of the thing,
not as a constant, re-run `score` on your own code, and do not set a bar that sits right next
to a score you care about.

## What Jev sees

This is not a knob, and it is the thing that changed most recently, so it comes before the
knobs. Every score below was produced with it, and the last time a number in this file was
measured without it, the text says so.

Jev is sent, for each piece: the path of the file, the piece's diff with **25 unchanged lines
above the change and 25 below**, read out of the snapshot, and the rules. In `functions` mode a
piece that is one function carries **that whole function after the change** instead of the wide
diff, and a piece of statements and declarations carries the wide diff, clamped so it never
reaches into a line another piece of that file owns. None of this changes what the agent is
handed: the report prints the piece with the tool's own 8 lines of context, and the first line of
the report says what Jev saw, once.

The clamp is only in `functions` mode, and only for the pieces that are not functions. In
`hunks` and `chunks` a piece is a whole hunk or a group of them, which is what the table below
was measured on, and the window there is left exactly as measured. In `functions` a piece can be
two lines inside a file, and pieces that small were never in that measurement: unclamped, two
import lines in a 19 line file scored 0.84 on the swallowed errors rule, because the window
reached into a neighbouring function's empty `catch`. Section 2 has the whole example.

```bash
stop-rules score --show-context     # prints exactly what Jev saw, per piece
```

### The measurement behind it

On the workbench, on 20 September 2026, over the same 240 real agent written changes, blind
labelled with an adjudicator on every disagreement, which hold 31 real breaks, at the default
bar of 0.5, cut one hunk per piece:

| What Jev was shown | Real breaks caught, of 31 | Plainly false flags | Flags nobody has ruled on |
|---|---|---|---|
| the piece alone, which is what it sent before | 23 | 10 | 23 |
| the piece with 25 lines around it, no parser | 21 | 7 | 13 |
| the whole function, with tree-sitter | 21 | 10 | not counted |

At a bar of 0.55 the wide form caught 16, with fewer doubtful flags than either the piece alone
or the whole function. On a second, much smaller set of real agent sessions it caught 2 of the 3
real breaks against 1 for the piece alone, and it found a missing doc comment the piece alone
missed. Whole functions caught the same 2 of 3, and needed the parser to do it.

What it costs: 7 of 1,358 clean pairs were newly flagged, which is the price of showing code the
rule is not about. Input tokens went from about $0.11 to $0.21 per 1,000 changes at TypeSafe's
published price. The wide form ships because it needs no parser, it works in every language, and
it argues with you less.

### What was tried and not built

- **A whole small file.** Good where it applied. 57% of the real pieces come from files over
  12 KB, so it does not apply often enough to be worth the code.
- **Asking Jev whether it needs more information.** A second question, "the code shown is not
  enough to decide this", answered "not enough" to 98% of the questions asked, and its answer
  had no relation to whether more context moved the score (AUC 0.27). No signal.
- **Widening only where that question asked for it.** 2 to 4 times the calls for no gain over
  widening every piece. Do not rebuild either of these two.

Two smaller measurements from the same work. Packing four pieces per call rather than one moved
answers by about 0.02, so the packing stays. The claim sentence that names the code around the
piece moved answers by 0.011 against the older one that named only the diff, and it is the
wording the table above was measured with, so it is the wording that ships.

### When a piece is too big to widen

A request is capped at 60,000 bytes. If the wide form of one piece would put a request carrying
only that piece over the cap, that piece goes to Jev with its diff alone. That is a recorded
fact, never a quiet retreat: the piece, its lines and the byte count go in `run.log`, the count
goes in `check --json` under `stats.tooBigToWiden`, and the first line of the report says how
many pieces it happened to. Measured on 20 September 2026, a change that rolls thirty 900
character lines into one:

```json
"tooBigToWiden": [ { "file": "src/rows.ts", "fromLine": 32, "toLine": 48, "bytes": 74830 } ]
```

```
stop-rules: no rule violations in your latest changes. 1 piece was too big to widen, so Jev saw it without the code around it.
```

`score --diff` is the one case with no lines around a change at all, because a diff file has no
file content to read them from. The output says so on its first line.

## 1. The bar: `threshold`

At or above the bar, a rule counts as broken and the piece goes back to the agent. Below it,
nothing happens. `0.5` is the default.

```bash
stop-rules check --threshold 0.6
```

### Where 0.5 comes from

The corpus below is where the number was set. The larger and later measurement, 96 agent
sessions on six projects with well-worded rules, is in section 3 ("The same 96 sessions,
scored again with reworded rules"): there 0.5 catches 56 of 62 with 26 false alarms and 0.6
catches 50 of 60 with 11. Both are true; they are different code.

One run, on the default cut of one hunk per piece, over 240 real agent written changes with
four of the starter rules, where an adjudicator ruled on every disagreement. It holds 29 real
problems:

| Bar | Real problems caught, of 29 | Plainly false flags | Arguable flags |
|---|---|---|---|
| 0.5 | 22 | 6 | 5 |
| 0.6 | 11 | 1 | 0 |

Read that as a choice, not as advice. Going from 0.6 to 0.5 doubles what is caught and costs
five more flags that are plainly wrong. We picked the catching. A team that is more annoyed by
noise than by a miss sets `"threshold": 0.6` and gives up half the catches. Nobody has measured
a bar between the two on this sample, so do not read anything into 0.55.

The later run in the tables further down uses all six starter rules, and nobody has ruled on
most of the flags it raises, so its counts are lower and its noise column is mostly unjudged.
It puts the two bars in the same order.

### Five examples, one rule

The rule is the starter rule about swallowed errors
([`rules-errors.md`](../examples/tuning/rules-errors.md)). The code is five small files in
[`bar.diff`](../examples/tuning/bar.diff).

```bash
stop-rules score --diff examples/tuning/bar.diff --rules examples/tuning/rules-errors.md
```

A diff file has no file content, so these five are the one case Jev sees no code around the
change. Seven runs, cold cache each time, same day, same model version:

| Example | What it is | Scores seen |
|---|---|---|
| `subtle.ts` | `await writeRow(...).catch(() => {})` and then a line that logs success | 0.92, 0.92, 0.92, 0.92, 0.92, 0.93, 0.93 |
| `swallow.ts` | an empty `catch` block, then a made up default | 0.89, 0.90, 0.90, 0.91, 0.91, 0.91, 0.92 |
| `cachemiss.ts` | a cache read whose `catch` returns `undefined`, which its comment says is the intended "ask the source" path | 0.45, 0.46, 0.47, 0.47, 0.48, 0.50, 0.80 |
| `notfound.ts` | returns `false` for `ENOENT` and rethrows everything else | 0.25, 0.30, 0.30, 0.31, 0.31, 0.32, 0.32 |
| `lookalike.ts` | logs the error with the file name and rethrows it | 0.06, 0.06, 0.06, 0.07, 0.07, 0.08, 0.08 |

How often each bar flagged each example, out of those seven runs:

| Bar | subtle | swallow | cachemiss | notfound | lookalike |
|---|---|---|---|---|---|
| 0.3 | 7 | 7 | 7 | 6 | 0 |
| 0.5 | 7 | 7 | 2 | 0 | 0 |
| 0.6 | 7 | 7 | 1 | 0 | 0 |
| 0.7 | 7 | 7 | 1 | 0 | 0 |
| 0.9 | 7 | 6 | 0 | 0 | 0 |

Re-run once on 20 September 2026 under the new claim sentence, on `jev-1.13.0`, those five came
back 0.92, 0.90, 0.46, 0.27 and 0.07, which is inside every range above. The seven-run study was
not repeated.

Four things to take from that.

- On clear cases the bar does not matter. Anything from 0.5 to 0.7 gives the same two flags
  here, every time, because the service is not sitting on the fence about them.
- The borderline example is where the bar earns its keep, and where it is least reliable.
  `cachemiss.ts` came back between 0.45 and 0.50 six times and 0.80 once. The default bar of
  0.5 flags it on some turns and not others, which is the honest cost of that default. If your
  codebase is full of that pattern on purpose, the answer is to reword the rule, not to hunt
  for a bar that splits 0.47 from 0.50.
- Whether `cachemiss.ts` is a real break depends on something the piece cannot show: is a
  broken cache the same as a cache miss for this caller. That is the kind of question a score
  cannot answer for you.
- We hoped `notfound.ts` would be a plain false alarm to show off a low score. It never went
  above 0.32, so it is not one. That is what the example really shows: a `catch` that rethrows
  what it cannot answer for reads as fine to the service.

### The measured tables

"Real breaks caught" counts (change, rule) pairs the reviewers, with the adjudicator's ruling
where there is one, call a real break. "Disputed flags" counts flags on a pair the reviewer
marked clean, and they split four ways by what the adjudicator said in the earlier round.
Most have **no ruling**: the adjudicator only looked at the disputes that came up at 0.5 on
whole chunks, so a flag with no ruling is neither a false alarm nor a real break. It is
unjudged, and we are not guessing. Pairs the adjudicator called arguable are left out of both
counts: 12 of them in the 240 change set.

Each table below is one scoring run of the whole sample per cut mode. Given the movement shown
above, a pair sitting near a bar could land on either side of it in another run, so read the
shape of these tables and not the last digit.

Cut into one hunk per piece, the default, over the first 172 of those changes and their 21 real
breaks. That mode stopped at 172 because the live call budget for this measurement ran out:

| Bar | Real breaks caught | Disputed flags | Ruled not a break | Ruled arguable | Ruled real | No ruling |
|---|---|---|---|---|---|---|
| 0.3 | 18 of 21 | 80 | 13 | 4 | 0 | 63 |
| 0.4 | 18 of 21 | 33 | 8 | 3 | 0 | 22 |
| 0.5 | 14 of 21 | 16 | 5 | 3 | 0 | 8 |
| 0.6 | 8 of 21 | 2 | 1 | 0 | 0 | 1 |
| 0.7 | 2 of 21 | 0 | 0 | 0 | 0 | 0 |

Cut into whole functions, over all 240 changes and their 32 real breaks:

| Bar | Real breaks caught | Disputed flags | Ruled not a break | Ruled arguable | Ruled real | No ruling |
|---|---|---|---|---|---|---|
| 0.3 | 30 of 32 | 157 | 18 | 9 | 1 | 129 |
| 0.4 | 27 of 32 | 79 | 15 | 7 | 1 | 56 |
| 0.5 | 20 of 32 | 38 | 7 | 5 | 1 | 25 |
| 0.6 | 10 of 32 | 19 | 5 | 2 | 0 | 12 |
| 0.7 | 3 of 32 | 3 | 1 | 0 | 0 | 2 |

Cut into chunks, over all 240 changes:

| Bar | Real breaks caught | Disputed flags | Ruled not a break | Ruled arguable | Ruled real | No ruling |
|---|---|---|---|---|---|---|
| 0.3 | 28 of 32 | 90 | 18 | 10 | 1 | 61 |
| 0.4 | 26 of 32 | 31 | 9 | 7 | 1 | 14 |
| 0.5 | 17 of 32 | 12 | 4 | 3 | 1 | 4 |
| 0.6 | 9 of 32 | 1 | 0 | 0 | 0 | 1 |
| 0.7 | 4 of 32 | 1 | 0 | 0 | 0 | 1 |

Per rule at the default bar of 0.5. Hunks is over 172 changes, whole functions and chunks over
all 240:

| Rule | hunks | functions | chunks |
|---|---|---|---|
| swallowed errors | 4 of 5 caught, 2 disputed | 9 of 10, 3 | 7 of 10, 2 |
| hidden fallbacks | 1 of 3, 0 | 2 of 4, 2 | 1 of 4, 3 |
| narrating comments | 5 of 8, 6 | 5 of 11, 11 | 5 of 11, 3 |
| weakened tests | 3 of 4, 0 | 3 of 5, 2 | 3 of 5, 0 |
| hardcoded to pass | 1 of 1, 8 | 1 of 1, 12 | 1 of 1, 4 |
| stubs and fake data | 0 of 0, 0 | 0 of 1, 8 | 0 of 1, 0 |

What the shape says: every step down the bar buys catches and pays in noise, and the noise
grows faster than the catches. On the default cut, from 0.6 to 0.5 catches go from 8 to 14 of
21 and disputed flags from 2 to 16. On whole functions over the 240 changes, catches double
from 10 to 20 and disputed flags double from 19 to 38. From 0.5 to 0.3, catches rise by half
again and disputed flags go up four times.

## 2. Cutting: `hunks` is the default, and what switching costs

Three ways to cut a change into the pieces that get judged. `hunks` is the default, and this
section is about what you gain and lose by switching to one of the other two.

- **`hunks`**, the default. One git diff hunk per piece, no parser. A hunk with more than 30
  added lines is cut right after the 30th, taking up to 3 trailing context lines with it, and
  each piece carries a recomputed `@@` header.
- **`functions`**. Each changed file is parsed with tree-sitter. Each function, method,
  constructor or accessor becomes a piece of its own. Everything else groups with its
  neighbours, up to 40 added lines. A file in a language with no grammar here is cut by hunk
  anyway.
- **`chunks`**. Also no parser. A file's hunks are grouped into pieces of up to 12,000 bytes,
  and a hunk bigger than that is halved until it fits.

```bash
stop-rules init --dir /path/to/repo                  # the default: one file, no parser
stop-rules init --dir /path/to/repo --cut functions  # adds the parser and the grammars
stop-rules check --cut chunks                        # one run, any mode
```

`init --cut functions` also writes `{"cut": "functions"}` into `.stop-rules.json`, so every
later run in that repository parses. Nothing changes mode on its own: a repository whose
settings say `functions` and that has no grammar files reports that, run after run, rather than
quietly falling back to hunks.

All three then go through the same packing: four pieces per request, and a request is also
bounded at 60,000 bytes.

### The same change, three ways

[`cutting.diff`](../examples/tuning/cutting.diff) adds one file with three functions. The
middle one swallows an error. The other two are fine.

The runs below are `stop-rules score` on that file in a scratch repository, on 20 September
2026, when the service reported `jev-1.13.0`.

The default cut, one hunk, so one piece:

```
stop-rules score: 1 piece, 1 scores, 1 Jev calls, 0 answers from the cache.
Scored the working tree against the last check, cut into one diff hunk each, with no parser.

1. notify.ts lines 1-19
   0.92  Do not silently swallow errors. ...
```

The file is new, so the one hunk already covers all of it and there is nothing around it to
add. That is why this score is the same as the one measured before Jev was given the lines
around a change.

`score --cut functions`, four pieces:

```
stop-rules score: 4 pieces, 4 scores, 1 Jev calls, 0 answers from the cache.
Scored the working tree against the last check, cut into whole functions, with tree-sitter.

1. notify.ts lines 7-14 in loadTemplate
   0.92  Do not silently swallow errors. ...

2. notify.ts lines 15-19 in notify
   0.42  Do not silently swallow errors. ...

3. notify.ts lines 1-2 in top-level code
   0.11  Do not silently swallow errors. ...

4. notify.ts lines 3-6 in subjectFor
   0.07  Do not silently swallow errors. ...
```

The third one is worth knowing the story of. The piece is two import lines, which break no rule.
The first build of this widened it like any other piece, and in a 19 line file the window is the
whole file, `loadTemplate` and its empty `catch` included, so it came back **0.84**, over the
default bar, on a piece whose added lines are two imports. So in `functions` mode a piece that is
not a function is now widened only into lines no other piece of the file owns: the window stops
at the first line of a neighbouring function, doc comment and all. Here that leaves the imports
and the blank line after them, and the score is 0.11. Measured on 20 September 2026 on
`jev-1.13.0`, in the same call, the same piece scored 0.84 unclamped and 0.07 clamped; the three
function pieces came straight back from the unclamped build's cache, so the clamp changed one
piece's question and no other. If a `top-level code` flag ever surprises you, run
`score --show-context` on it and read the window.

Cutting into chunks gives the same single piece as the default here. A new file is one hunk, and
19 added lines is under both the 30 line cut and the 12,000 byte one. The two part company on
bigger changes: over the 240 change sample, `hunks` makes 804 pieces where `chunks` makes 240.

`notify` scored 0.45 when it was sent alone, a function that breaks no rule but calls the one
that does. With the whole function it is 0.42. Cutting small does not make every piece obviously
clean, and the numbers near a bar move: read the shape.

At the default bar of 0.5 all three modes flag this change once, and the agent is handed
something different. `--cut functions`, eight lines:

```
stop-rules: 1 rule violation in 1 place in your latest changes. Jev saw the whole function for 3 pieces and 25 lines around the other 1.
Fix each one. If a rule truly should not apply here, leave the code and tell the user why.

1. notify.ts lines 7-14 in loadTemplate breaks 1 rule
   Rule: Do not silently swallow errors. ...
   Confidence: 0.92
   The change this is about:
   @@ -0,0 +7,8 @@ export function loadTemplate(file: string): string {
   +
   +export function loadTemplate(file: string): string {
   +  try {
   +    return readFileSync(file, "utf8");
   +  } catch (error) {
   +  }
   +  return "";
   +}
```

The default mode, and chunks, hand over the whole file and the agent finds the fault itself:

```
stop-rules: 1 rule violation in 1 place in your latest changes. Jev saw 25 lines around it.
Fix each one. If a rule truly should not apply here, leave the code and tell the user why.

1. notify.ts lines 1-19 breaks 1 rule
   Rule: Do not silently swallow errors. ...
   Confidence: 0.92
   The change this is about:
   @@ -0,0 +1,19 @@
   +import { readFileSync } from "node:fs";
   +import { sendEmail } from "./email.js";
   +
   +export function subjectFor(kind: string): string {
   ... 15 more lines
```

### The trade-offs

The measured columns are over the same 172 changes, because that is what all three modes have
scores for. They were measured with the piece alone, before Jev was given the code around it,
so read them as how the three ways of cutting compare with each other and not as this build's
score. The pieces, calls and token rows were re-run on 20 September 2026.

| | `hunks`, the default | `functions` | `chunks` |
|---|---|---|---|
| Install size, a TypeScript and Python repo | 1 file, 334,419 bytes | 4 files, 3,340,480 bytes (`stop-rules.mjs`, `tree-sitter.wasm` 205,488, `grammars/typescript.wasm` 2,342,690, `grammars/python.wasm` 457,883) | 1 file, 334,419 bytes |
| Languages | every language | 10 have a parser: TypeScript, TSX, JavaScript, Python, Go, Rust, Ruby, Java, Kotlin, Swift. Any other file is cut into hunks | every language |
| What the agent is handed | the hunk the fault sits in | the one function at fault | up to 12,000 bytes of diff |
| Pieces, 172 changes | 532 | 643 | 172 |
| Jev requests, 172 changes | 214 | 247 | 172 |
| Input tokens, 172 changes | 433,421 | 490,231 | 269,307 |
| Pieces, calls and tokens on `cutting.diff` with one rule, 20 September 2026 | 1 piece, 1 call, 582 in and 23 out | 4 pieces, 1 call, 1,448 in and 80 out | 1 piece, 1 call, 582 in and 23 out |
| What Jev is shown per piece | the piece plus 25 lines each way | the whole function, or, when the piece is not one, up to 25 lines each way of what no other piece owns | the piece plus 25 lines each way |
| Real breaks caught at the default 0.5, of 21 | 14 | 11 | 9 |
| Disputed flags at 0.5 | 16 | 26 | 6 |
| Real breaks caught at 0.6, of 21 | 8 | 5 | 5 |
| Disputed flags at 0.6 | 2 | 14 | 0 |
| A file that will not parse | checked, nothing parses it | reported as not checked, never checked half way | checked, nothing parses it |
| A file whose grammar is not installed | not possible | reported once as not checked, with the command to fix it | not possible |

Two samples, and they do not agree on how much each mode catches, so here are both. The table
above is one scoring run per mode over 172 changes with all six starter rules, where most
disputed flags have no ruling. The earlier run, over 240 changes with four of the rules and an
adjudicator on every disagreement, holds 29 real problems and is where the default bar comes
from: at 0.5 one hunk per piece caught 22 with 6 plainly false flags and 5 arguable,
tree-sitter pieces 16 with 4, and big chunks 12 with 0. Different samples, different rules,
same order.

What you gain by switching, and lose:

- **`hunks`**, the default, is bad at this: a new file is one giant hunk, so it gets cut blindly
  every 30 added lines with no regard for where a function starts or ends. Two functions that
  sit next to each other share a hunk. A hunk can start in the middle of a function, so the
  agent is handed a piece of code with no head, even though Jev saw 25 lines around it.
- **`functions`** buys the agent exactly one function, named, with nothing else in it, and Jev
  the whole of that function. It costs the grammar files, which are megabytes in the repository,
  and it only knows the ten languages listed above. A file it cannot parse is not checked at
  all, and a language whose grammar is missing is not checked either. Its pieces that are not
  functions, meaning the imports, constants and type declarations, are small, so their window is
  clamped to the lines no other piece owns and is often only a line or two wide. That is on
  purpose: unclamped, the example above turned two import lines into a 0.84.
- **`chunks`** buys the fewest requests and the fewest tokens. It costs the most dilution: one
  bad line sits in a big diff, which is the quietest setting of the three and the one that
  misses most at a low bar, and the agent is handed a large diff to search.

The parse behaviours are worth seeing for real. A file with broken syntax and a `.sql` file,
with `--cut functions`, on 20 September 2026:

```
stop-rules: no rule violations in the 1 piece that was checked, and 1 not checked, listed below. Jev saw 25 lines around it.

Not checked (1): broken.ts lines 1-5: could not be parsed as TypeScript
```

```json
"cutByHunk": [ { "file": "schema.sql", "reason": "no grammar for .sql" } ]
```

The same repository in the default mode checks the broken file and finds the fault in it:

```
stop-rules: 1 rule violation in 1 place in your latest changes. Jev saw 25 lines around it.
Fix each one. If a rule truly should not apply here, leave the code and tell the user why.

1. broken.ts lines 1-5 breaks 1 rule
   Rule: Do not silently swallow errors. ...
   Confidence: 0.96
   The change this is about:
   @@ -0,0 +1,5 @@
   +export function load(file: string): string {
   +  try {
   +    return readFileSync(file "utf8");
   +  } catch (error) {
   +}
```

Same repository, same rule, same file. The default mode judged it and `functions` did not.

## 3. Rules

Rules are not in `.stop-rules.json`. They are in `.stop-rules.md`, one top-level list item
each, and they are the knob that changes the most. Every rule adds one question per piece.

### Which rules Jev can judge

This is the part that decides whether the tool is worth running at all, so it is the part
with the most honest numbers we have. Two sources, and they are kept apart on purpose.

- **The experiment.** On 19 September 2026, 16 real Claude Code sessions (Sonnet and Haiku)
  worked on one small service that had 8 team specific rules the agent could not see. Its
  numbers below are that experiment's own, not something re-run for this file.
- **The examples.** The small files in [`examples/tuning/`](../examples/tuning), scored
  against the live service on 19 September 2026. Asked for its version on the same day, the
  service answered `jev-1.13.0`. Every example score below was printed by the command shown
  next to it, twice, with a cold cache each time.

Both samples are small. Sample sizes are beside every number.

#### Six projects, 96 sessions

The larger measurement, run on 20 and 21 September 2026. Six small projects were written for
it, one each in Ruby, Python, Go, Rust, React and a near-empty TypeScript seed. Each had 8
team rules the agent never saw and 8 tasks, 4 that extend existing code and 4 that add a new
subsystem. Each task was run once with Sonnet and once with Haiku in a real Claude Code
session with this hook live, at its defaults: bar 0.5, one hunk per piece, four pieces per
call. A blind reader who saw only the change and the rules wrote the answer key before any
score was looked at. A flag in a file the reader did not name went to a second reviewer, who
ruled it real, arguable or not a break, so nothing below is a false alarm by default. One
bare-seed Sonnet session stopped at a permission question with no change and was run again.

The tool's own output, at its own bar:

| | all six projects |
|---|---|
| real breaks the agents made unprompted | 59 |
| caught, in the right file | 43 |
| caught, right rule, wrong file | 5 |
| missed | 11 |
| false alarms (a reviewer ruled not a break) | 18 |
| arguable (the rule's wording decides) | 10 |
| Jev calls, all 96 sessions | 374 |
| cost, all 96 sessions | $0.07 |

Haiku broke a rule in 30 of its 48 sessions (39 breaks). Sonnet broke one in 11 of 48 (13
breaks).

Per project:

| project | the base code | real breaks | caught | wrong file | missed | false alarms | arguable |
|---|---|---|---|---|---|---|---|
| Go service | old half breaks 4 of the 8 rules | 17 | 13 | 3 | 1 | 5 | 2 |
| TypeScript seed | nearly empty, nothing to copy | 15 | 11 | 0 | 4 | 3 | 2 |
| Ruby, Rails-shaped | follows all 8 | 11 | 7 | 1 | 3 | 2 | 1 |
| React front end | follows all 8 | 8 | 6 | 0 | 2 | 3 | 1 |
| Python service | follows 6, silent on 2 | 6 | 5 | 0 | 1 | 4 | 2 |
| Rust CLI | follows 7, silent on 1 | 2 | 1 | 1 | 0 | 1 | 2 |

Per kind of rule:

| kind of rule | rules | real breaks | caught | wrong file | missed | false alarms | arguable |
|---|---|---|---|---|---|---|---|
| never call X, use Y | 24 | 35 | 27 | 3 | 5 | 5 | 3 |
| layer or folder | 8 | 7 | 7 | 0 | 0 | 9 | 2 |
| something must be present | 6 | 7 | 6 | 0 | 1 | 2 | 1 |
| needs another file | 6 | 5 | 3 | 2 | 0 | 0 | 3 |
| a value's format | 3 | 3 | 0 | 0 | 3 | 0 | 0 |
| judgment | 4 | 2 | 0 | 0 | 2 | 2 | 1 |

Per kind of task, all projects: the 48 extend tasks had 20 real breaks, 15 caught, 5 false
alarms; the 48 new-subsystem tasks had 39 real breaks, 28 caught in the right file, 5 in the
wrong one, 13 false alarms and 8 arguable.

By what the base code does about the rule: where the old code already breaks a rule (the Go
project, 4 rules), 10 breaks, 9 caught, 0 false alarms. Where the code says nothing about the
rule, 16 breaks, 12 caught, 3 false alarms. Where the code already follows the rule, 33
breaks, 22 caught, 5 in the wrong file, 15 false alarms and 8 arguable.

Where the 28 wrong or arguable flags came from: 12 were on test files where the rule said
nothing about tests (a test that starts its own HTTP server, a test that builds a path
directly, a Go test that cannot take a context as its first argument). 7 were layer rules
flagged on a file outside the layer the rule restricts (a model, the composition root, a
README). The rest are one-offs. The two lines in the rule-writing guide, say what the rule
means for tests and name the folder a layer rule applies to, come from this.

What the agent did with a flag, over 96 sessions: the hook reported something in 46; the agent
fixed the code in 28, argued and changed nothing in 13, and did something else in 5. A
re-check of the final tree was clean in 52 of 96 sessions.

The same first-stop trees scored again one piece per call, to show the bar:

| bar | caught | false alarms | flags nobody has ruled on |
|---|---|---|---|
| 0.4 | 56 of 59 | 14 | 89 |
| 0.5 | 48 of 58 | 9 | 41 |
| 0.6 | 43 of 57 | 6 | 13 |
| 0.7 | 35 of 55 | 3 | 5 |

Raising the bar from 0.5 to 0.7 gives up 13 catches to remove 6 false alarms. The last column
is large at the low bars: those flags fell in files the blind reader did not name and nobody
has judged them, so they count neither way.

#### The same 96 sessions, scored again with reworded rules

After the tables above were written, 14 of the 48 rules were reworded in three ways and
nothing else changed: say what the rule means for tests, name the folder a layer rule is
about, turn a soft clause into a concrete ban. The same saved changes were scored again, one
piece per call, and a reader ruled on every new flag.

| | original wording | reworded |
|---|---|---|
| real breaks caught | 48 of 59 | 56 of 62 |
| missed | 9 | 5 |
| false alarms | 35 | 26 |
| arguable | 8 | 8 |

(The total of real breaks grew because the reworded rules found 3 breaks nobody had recorded,
and a reviewer ruled them real.) 27 flags went away, all but one on a test file, a file
outside the named folder, or a README. 15 appeared, 8 of them real breaks. Value-format rules
went from 0 of 3 caught to 3 of 3. Layer rules kept 7 of 7 with false alarms from 8 to 3.

Two things that were measured at the same time and did not help:

- **One piece per call instead of four.** Packing pulls every score down a little. Unpacked,
  the same changes gave 48 of 59 caught with 35 false alarms against the packed hook's 43 of
  59 with 18, at four times the calls. Unpacked at bar 0.6 lands where the packed hook at 0.5
  already is. The default stays packed.
- **A bar of 0.4.** The 93 flags between 0.4 and 0.5 that nobody had judged were ruled: 1 real,
  13 arguable, 79 not a break.

With the reworded rules, the bar trades like this, all six projects pooled:

| bar | caught | false alarms | arguable |
|---|---|---|---|
| 0.5 | 56 of 62 | 26 | 8 |
| 0.6 | 50 of 60 | 11 | 5 |
| 0.7 | 42 of 57 | 3 | 0 |

Layer and value-format rules lose no catches up to 0.7; "never call X" rules lose 2 at 0.6
and 10 at 0.7. There is no per-kind bar in the tool: it would save about 7 false alarms in 96
sessions and needs someone to sort the rules by hand.

The one-project experiment of 19 September below is kept as it was written; the six-project
numbers above supersede its headline.

#### Works: "never call X, use Y instead", where X is a name the code shows

The rule names something that is either in the added lines or is not, and the piece is
enough to tell. In the experiment, a raw HTTP call in a codebase that has its own helper
scored 0.88 in a real session and the agent fixed it (1 case). Planted `fetch(`,
`console.log` and `toFixed` scored 0.92, 0.94 and 0.87 (1 case each).

Our own pair is [`rules-helper.md`](../examples/tuning/rules-helper.md) and
[`helper.diff`](../examples/tuning/helper.diff): one function that calls `fetch` and one
that calls the team's helper, nothing else different.

```bash
stop-rules score --diff examples/tuning/helper.diff --rules examples/tuning/rules-helper.md
```

| Piece | What it is | Scores seen |
|---|---|---|
| `src/user.ts` | calls `fetch` directly, which the rule forbids | 0.92, 0.92, 0.93 |
| `src/team.ts` | calls `httpGet`, which the rule asks for | 0.10, 0.10, 0.11 |

Three runs, cold cache each, the third on 20 September 2026 under the new claim sentence, 0.82 apart. That gap is what a rule of this kind buys you: any bar
between 0.2 and 0.9 gives the same answer.

#### Careful: a rule whose answer depends on which layer or folder the file is in

The rule we mean is "handlers must not touch storage, services may". In the experiment it
inverted: the highest scores landed on the services the rule allows (0.69) and a real breach
in a handler scored 0.11 (1 real breach, 8 rules, 16 sessions).

Our own pair is [`rules-layers.md`](../examples/tuning/rules-layers.md) and
[`layers.diff`](../examples/tuning/layers.diff), four files, two per layer, where the second
pair is the same function written twice so the folder is the only difference.

```bash
stop-rules score --diff examples/tuning/layers.diff --rules examples/tuning/rules-layers.md
```

| Piece | What it is | Scores seen |
|---|---|---|
| `src/handlers/orders.ts` | a handler taking a `Request`, querying the database | 0.93, 0.93, 0.93 |
| `src/handlers/report.ts` | a plain function in `handlers/`, querying the database | 0.89, 0.89, 0.92 |
| `src/services/report.ts` | the same function in `services/`, which the rule allows | 0.19, 0.19, 0.23 |
| `src/services/orders.ts` | a service reading one row, which the rule allows | 0.10, 0.11, 0.10 |

That is the opposite of the experiment, and we are not going to pretend the two agree. On
these four files the folder in the path was enough, even for the pair whose code is identical.
In the experiment, on real handlers and services, it was not. The difference we can point at
is what the piece carries: a path with `handlers/` in it and code that obviously belongs to
one layer is a signal, and a real file whose name says nothing about its layer leaves Jev
guessing. So this kind of rule is not reliable, it is conditional, and `score` on your own
code is the only way to find out which side yours falls on. Three runs each, the third on 20 September 2026 under the new claim sentence, one pair of
examples, one experiment.

#### Does not work: a rule about something that is missing

"Every exported function has a doc comment." In the experiment the one real breach scored
0.21, while code the rule allows scored as high as 0.48 (1 real breach). The scores are not
just low, they are in the wrong order. A linter checks this properly, for nothing, every
time.

#### Does not work: a rule that needs the rest of the file or the codebase

A piece is all Jev is given, so "this option is used nowhere else" or "this duplicates
something in another module" is a guess dressed as a number. The measured version of that is
already in this file: the "do not add options nothing uses" rule caused 55 of 71 false alarms
when code was judged piece by piece.

#### The honest headline: imitation does most of the work

In the one-project experiment, in a codebase that already shows its own conventions, Sonnet
and Haiku followed all 8 house rules by imitation in 14 of the 16 sessions: 3 real breaks, 1
caught, 2 missed, 1 false alarm. The six projects say the same thing with more data: where the
code already follows the rules and the task extends it, the agents mostly copy what they see
(Rust: 2 breaks in 16 sessions). The tool earned its keep in two places: old code that
already breaks the rules (Go: 17 breaks in 16 sessions, 16 pointed at), and new subsystems or
a bare seed with nothing to copy from (39 breaks in the new-subsystem tasks, 33 pointed at).

Set your expectations from that. Rules that repeat what your code already demonstrates buy
little. Rules about the thing your codebase has no example of yet, and rules of the "never
call X, use Y" kind, are where this is worth a Jev call.

#### Told once, and quiet is not clean

The hook delivers a finding once per repository and never nags. If the agent decides the rule
does not apply and changes nothing, the next turn is silent while the code still breaks the
rule. 3 of the 16 sessions ended exactly that way: the agent argued, the code stayed, the
hook went quiet, and `stop-rules check --base HEAD` still reported the finding.

So `check --base <rev>` is the gate to trust. It is read only, it skips nothing it has told an
agent about, and it prints the same finding every time. It also has no way to mark a finding
as accepted, so a false alarm keeps being reported there until you reword the rule or change
the code. There is no accept or ignore list, on purpose: whether to have one is not decided.

### Four wordings, one change

[`rules-demo.diff`](../examples/tuning/rules-demo.diff) adds a retry helper with a narrating
comment, a local variable nothing reads, and an option nothing uses.

```bash
stop-rules score --diff examples/tuning/rules-demo.diff --rules examples/tuning/rules-with-examples.md
```

Three runs each, on three days of the same model version. The third, on 20 September 2026, is
the first under the claim sentence that names the code around the piece:

| Rules file | The rule | Scores seen |
|---|---|---|
| [`rules-with-examples.md`](../examples/tuning/rules-with-examples.md) | Do not write comments that only restate what the code does, or that narrate the change being made ("now we also handle X", "fixed the bug where"). A comment that explains why the code must be this way is fine. | 0.89, 0.89, 0.87 |
| [`rules-terse.md`](../examples/tuning/rules-terse.md) | No useless comments. | 0.25, 0.28, 0.32 |
| [`rules-linter.md`](../examples/tuning/rules-linter.md) | Do not leave a variable that nothing reads. | 0.57, 0.62, 0.66 |
| [`rules-codebase.md`](../examples/tuning/rules-codebase.md) | Do not add configuration options, parameters or abstractions that nothing in this change uses. | 0.62, 0.66, 0.73 |

The same comment, in the same change, is a 0.89 under the long rule and a 0.25 under the
short one, and on the third run 0.87 against 0.32. The examples inside the rule are doing the work.

The linter rule scores between 0.57 and 0.66 on a variable that really is unused. ESLint's
`no-unused-vars` gives you the same answer for nothing, every time, with the line number.
Paying a Jev question for it buys you a maybe.

The codebase rule scores between 0.62 and 0.73 on an option that nothing in the piece uses. Whether
anything in the repository uses it is a question this piece cannot answer, so a score like
that is a guess dressed as a number.

### What we measured about rules

- Wordings that carry their own examples beat terse ones on all three rule families we
  tried.
- The "do not add options nothing uses" rule caused 55 of 71 false alarms when code was
  judged piece by piece. It is the reason the starter rules do not include it.
- "An error message must say what failed and include the value that caused it" caught 0 of 8
  real cases. It was removed from the starter rules and a reworded version did no better.

### What rules cost

The same change, [`cutting.diff`](../examples/tuning/cutting.diff), one piece, cold cache:

| Rules | Questions | Calls | Input tokens | Output tokens |
|---|---|---|---|---|
| [3](../examples/tuning/rules-three.md) | 3 | 1 | 696 | 61 |
| [12](../examples/tuning/rules-twelve.md) | 12 | 1 | 1,234 | 234 |

Four times the rules is not four times the cost, because the piece is sent once and the rules
ride along with it. It is about 1.8 times the input tokens here. Five to fifteen rules is the
range we would stay in, for noise rather than for money.

## 4. Calls per run: `maxCalls`

One run sends at most this many requests to Jev, counted across retries and splits. `60` is
the default, which is far more than a normal turn needs: four pieces ride in one request, so a
change that touches forty hunks is ten requests.

When the budget runs out, the work left over is reported and nothing pretends it was checked.
Ten new files, one hunk each, in the default mode, with a budget of one request:

```bash
stop-rules check --max-calls 1
```

```
stop-rules: no rule violations in the 4 pieces that were checked, and 6 not checked, listed below. Jev saw 25 lines around it.

Not checked (6):
  src/step4.ts lines 1-4: call budget exhausted
  src/step5.ts lines 1-4: call budget exhausted
  src/step6.ts lines 1-4: call budget exhausted
  src/step7.ts lines 1-4: call budget exhausted
  src/step8.ts lines 1-4: call budget exhausted
  src/step9.ts lines 1-4: call budget exhausted
```

The one request covered four pieces. The next run picks the rest up, and the four already
answered cost nothing because they are in the cache:

```json
{"mode":"check","cut":"hunks","pieces":10,"checked":4,"calls":1,"cacheHits":0,"notChecked":6,"widened":10,"withFunction":0,"tooBigToWiden":0}
{"mode":"check","cut":"hunks","pieces":10,"checked":10,"calls":2,"cacheHits":4,"notChecked":0,"widened":10,"withFunction":0,"tooBigToWiden":0}
```

`checked` is how many pieces got an answer. When it is 0 and `files` is not, nothing in the
change was judged, and the first line of the report says so rather than reading as clean.

In hook mode the baseline does not move when a run runs out of budget, so the same change is
checked again on the next turn until it is finished.

## 5. What it costs in money

TypeSafe's launch post for System One and Jev says, word for word:

> Input tokens: $0.042 / MTok ($42 per billion tokens).

> Output tokens: FREE (too cheap to meter).

That is <https://typesafe.ai/blog/introducing-system-one-models-and-jev>, posted 15 September
2026 and read on 19 September 2026. Prices change, so check the post rather than trusting
this paragraph, and note that the price is theirs to set, not ours. Nothing in the tool
knows a price: `check --json` and `run.log` give you input tokens, and you do the sum.

At $0.042 per million input tokens, and output free, from our own measured runs. The first four
rows were re-run on 20 September 2026, with the lines around each piece in them. The three
sample rows were measured before that change, with the piece alone:

| What was measured | Input tokens | Cost |
|---|---|---|
| One 19 line file, one rule, cut the default way (1 piece) | 582 | $0.00002 |
| The same file, cut into functions (4 pieces) | 1,448 | $0.00006 |
| The same file with 3 rules | 696 | $0.00003 |
| The same file with 12 rules | 1,234 | $0.00005 |
| 172 sample changes, cut the default way, the piece alone | 433,421 | $0.018 |
| All 240 sample changes, cut into functions, the piece alone | 668,891 | $0.028 |
| All 240 sample changes, cut into chunks, the piece alone | 383,892 | $0.016 |

Per change that works out at 2,520 input tokens on the default cut, which is $0.00011, and
2,787 cut into whole functions, which is $0.00012. A thousand agent turns of that size cost
about 11 or 12 cents with the piece alone. The lines around each piece roughly double that: the
workbench measured $0.21 per 1,000 changes against $0.11 on the same sample. Going from 3 rules
to 12 raised the input tokens by about 80 percent on our one piece test, and a second run over
the same code is free because the answers are cached.

Latency, from the same runs: the median change took 192 ms of Jev time on the default cut and
203 ms cut into functions. The check itself adds the git snapshot, and in `functions` mode the
parse, so a blocking hook feels like about a second either way.

## 6. Background or blocking, one person or a team

**In Claude Code** the hook entry `init` writes has `asyncRewake`, so the check runs in the
background and the agent is woken when there is something to fix. The agent sees nothing at
all on a clean turn. Every other agent runs the check as a normal blocking hook, which takes
about a second.

In `claude -p` (print mode) a background hook is killed when the process exits. Drop
`asyncRewake` from the settings entry there and take the blocking form.

**One person**: your Jev key lives in `~/.config/stop-rules/jev-key`, mode 0600. Nothing in
the repository holds it.

**A team**: one person deploys the server, which holds the key, and everyone else stores a
team token. Set it with `endpoint` in `.stop-rules.json`, which is committed.

Jev's rate limit is per account, so the whole team shares it, and so does every tool on your
machine. About 16 requests in flight per account is fine. The tool's own caps are 4 in flight
per run, 8 per machine, and 12 per server instance. On serverless platforms the server cap is
per instance, so a busy team on a platform that starts many instances can still push the
account over its limit.

## 7. Things that are fixed, and why

These are not knobs. Each one was measured, and none of them is worth a setting.

- **Four pieces per request.** Packing four moved scores by 0.03 on average against asking
  one at a time. Eight per request was slightly worse at high bars.
- **40 added lines per piece for code that is not a function.** Single statements are too
  small to judge alone: 1,439 one-unit pieces became 441 useful ones when neighbours were
  merged up to 40 lines. A function is always its own piece, whatever its size.
- **30 added lines and 3 trailing context lines per piece in hunks mode.** That is the
  splitting the sample was measured with.
- **25 unchanged lines around each change, for Jev.** The width that was measured. Narrower was
  not tried; wider was not tried either, because the whole file was, and it did not apply often
  enough. See "What Jev sees" above for the table and for the two things that did not work.
- **Three rounds.** After three turns of the same findings the tool stops waking the agent
  and leaves them for you. An agent that has not fixed something in three tries is not going
  to.
- **Lines longer than 1,000 characters are left out of the piece,** with a marker in their
  place. They are minified bundles and base64 blobs, they cost a fortune in tokens, and no
  coding rule is about them.
- **Lock files, minified bundles, maps, snapshots, logs, CSV and TSV files, SVGs and binaries
  are skipped,** and `check --json` lists what was skipped and why.
