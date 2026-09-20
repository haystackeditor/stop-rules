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
  "cut": "functions",
  "threshold": 0.6,
  "maxCalls": 60
}
```

| Knob | File key | Flag | Default |
|---|---|---|---|
| Where questions go | `endpoint` | `--team <url>` on `init` | your own Jev key |
| How a change is cut into pieces | `cut` | `--cut functions\|hunks\|chunks` | `functions` |
| The bar a score must reach | `threshold` | `--threshold <0..1>` | `0.6` |
| Requests to Jev in one run | `maxCalls` | `--max-calls <n>` | `60` |

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
file has no file content, so it cannot be cut into functions, and the output says which cut
was used instead.

## About the numbers in this file

Two kinds of number appear below.

- **Measured totals** come from 240 real changes written by coding agents in 104 public
  repositories, labelled blind by reviewers and, where Jev and a reviewer disagreed in an
  earlier round, ruled on by an adjudicator. That is a small sample of other people's code.
  Your code will give you different numbers.
- **Example scores** come from the small examples in
  [`examples/tuning/`](../examples/tuning), which we wrote for this file. Every one of them
  is a real answer from the live service on 19 September 2026. Asked on the same day, the
  service reported its version as `jev-1.13.0`. The tool asks for `jev-latest`.

Two things about the numbers themselves. Scores drift between model versions. They also move
a little between runs: the same piece and the same rule came back 0.92 once and 0.93 another
time, minutes apart, on the same version. Treat every number here as the shape of the thing,
not as a constant, and re-run `score` on your own code after a model change.

## 1. The bar: `threshold`

At or above the bar, a rule counts as broken and the piece goes back to the agent. Below it,
nothing happens. `0.6` is the default.

```bash
stop-rules check --threshold 0.5
```

### Five examples, one rule

The rule is the starter rule about swallowed errors
([`rules-errors.md`](../examples/tuning/rules-errors.md)). The code is five small files in
[`bar.diff`](../examples/tuning/bar.diff).

```bash
stop-rules score --diff examples/tuning/bar.diff --rules examples/tuning/rules-errors.md
```

| Example | What it is | Score |
|---|---|---|
| `subtle.ts` | `await writeRow(...).catch(() => {})` and then a line that logs success | 0.92 |
| `swallow.ts` | an empty `catch` block, then a made up default | 0.90 |
| `cachemiss.ts` | a cache read whose `catch` returns `undefined`, which its comment says is the intended "ask the source" path | 0.80 |
| `notfound.ts` | returns `false` for `ENOENT` and rethrows everything else | 0.25 |
| `lookalike.ts` | logs the error with the file name and rethrows it | 0.06 |

Which bar lets which one through:

| Bar | Flags |
|---|---|
| 0.3 | subtle, swallow, cachemiss |
| 0.5 | subtle, swallow, cachemiss |
| 0.6 | subtle, swallow, cachemiss |
| 0.7 | subtle, swallow, cachemiss |
| 0.9 | subtle, swallow |

Three things to take from that.

- On clear cases the bar does not matter. Anything from 0.3 to 0.7 gives the same three
  flags here, because the service is not sitting on the fence about any of these five.
- `cachemiss.ts` is the one that will annoy you. It scores 0.80, and whether it is a real
  break depends on a decision the piece cannot show: is a broken cache the same as a cache
  miss for this caller. If your codebase is full of that pattern on purpose, a bar of 0.6
  will keep flagging it, and the answer is to reword the rule, not to move the bar.
- We hoped `notfound.ts` would be a plain false alarm to show off a low score. It scored
  0.25, so it is not one. That is what the example really shows: a `catch` that rethrows what
  it cannot answer for reads as fine to the service.

### The measured tables

"Real breaks caught" counts (change, rule) pairs the reviewers, with the adjudicator's ruling
where there is one, call a real break. "Disputed flags" counts flags on a pair the reviewer
marked clean, and they split four ways by what the adjudicator said in the earlier round.
Most have **no ruling**: the adjudicator only looked at the disputes that came up at 0.5 on
whole chunks, so a flag with no ruling is neither a false alarm nor a real break. It is
unjudged, and we are not guessing. Pairs the adjudicator called arguable are left out of both
counts: 12 of them in the 240 change set.

Cut into whole functions, the default, over all 240 changes and their 32 real breaks:

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

Cut into one hunk per piece, over the first 172 of those changes and their 21 real breaks.
That mode stopped at 172 because the live call budget for this measurement ran out:

| Bar | Real breaks caught | Disputed flags | Ruled not a break | Ruled arguable | Ruled real | No ruling |
|---|---|---|---|---|---|---|
| 0.3 | 18 of 21 | 80 | 13 | 4 | 0 | 63 |
| 0.4 | 18 of 21 | 33 | 8 | 3 | 0 | 22 |
| 0.5 | 14 of 21 | 16 | 5 | 3 | 0 | 8 |
| 0.6 | 8 of 21 | 2 | 1 | 0 | 0 | 1 |
| 0.7 | 2 of 21 | 0 | 0 | 0 | 0 | 0 |

Per rule at 0.5. Whole functions and chunks are over all 240 changes, hunks over 172:

| Rule | functions | hunks | chunks |
|---|---|---|---|
| swallowed errors | 9 of 10 caught, 3 disputed | 4 of 5, 2 | 7 of 10, 2 |
| hidden fallbacks | 2 of 4, 2 | 1 of 3, 0 | 1 of 4, 3 |
| narrating comments | 5 of 11, 11 | 5 of 8, 6 | 5 of 11, 3 |
| weakened tests | 3 of 5, 2 | 3 of 4, 0 | 3 of 5, 0 |
| hardcoded to pass | 1 of 1, 12 | 1 of 1, 8 | 1 of 1, 4 |
| stubs and fake data | 0 of 1, 8 | 0 of 0, 0 | 0 of 1, 0 |

What the shape says: every step down the bar buys catches and pays in noise, and the noise
grows faster than the catches. From 0.6 to 0.5 on whole functions, catches double from 10 to
20 and disputed flags double from 19 to 38. From 0.5 to 0.3, catches rise by half again and
disputed flags go up four times.

## 2. Cutting: `functions`, `hunks` or `chunks`

Three ways to cut a change into the pieces that get judged.

- **`functions`**, the default. Each changed file is parsed with tree-sitter. Each function,
  method, constructor or accessor becomes a piece of its own. Everything else groups with its
  neighbours, up to 40 added lines.
- **`hunks`**. One diff hunk per piece, no parser. A hunk with more than 30 added lines is
  cut right after the 30th, taking up to 3 trailing context lines with it, and each piece
  carries a recomputed `@@` header.
- **`chunks`**. Also no parser. A file's hunks are grouped into pieces of up to 12,000 bytes,
  and a hunk bigger than that is halved until it fits.

```bash
stop-rules init --dir /path/to/repo --cut hunks   # copies no parser files
stop-rules check --cut chunks                     # one run, any mode
```

All three then go through the same packing: four pieces per request, and a request is also
bounded at 60,000 bytes.

### The same change, three ways

[`cutting.diff`](../examples/tuning/cutting.diff) adds one file with three functions. The
middle one swallows an error. The other two are fine.

Cut into whole functions, four pieces:

```
1. notify.ts lines 7-14 in loadTemplate
   0.92  Do not silently swallow errors. ...

2. notify.ts lines 15-19 in notify
   0.47  Do not silently swallow errors. ...

3. notify.ts lines 1-2 in top-level code
   0.08  Do not silently swallow errors. ...

4. notify.ts lines 3-6 in subjectFor
   0.08  Do not silently swallow errors. ...
```

Cut into hunks, and cut into chunks, one piece either way:

```
1. notify.ts lines 1-19
   0.93  Do not silently swallow errors. ...
```

A new file is one hunk, and 19 added lines is under both the 30 line cut and the 12,000 byte
one, so `hunks` and `chunks` are the same single piece here. They part company on bigger
changes: over the 240 change sample, `hunks` makes 804 pieces where `chunks` makes 240.

Notice the 0.47 on `notify`, a function that breaks no rule. It calls the function that does.
Cutting small does not make every piece obviously clean.

At a bar of 0.6 all three modes flag this change once, and the agent is handed something
different. Whole functions, eight lines:

```
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

Hunks or chunks, the whole file, and the agent finds the fault itself:

```
1. notify.ts lines 1-19 breaks 1 rule
   Rule: Do not silently swallow errors. ...
   Confidence: 0.93
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
scores for.

| | `functions` | `hunks` | `chunks` |
|---|---|---|---|
| Install size, a TypeScript and Python repo | 4 files, 4,224 KB (`stop-rules.mjs`, `tree-sitter.wasm`, `grammars/typescript.wasm`, `grammars/python.wasm`) | 1 file, 384 KB | 1 file, 384 KB |
| Languages | 10 have a parser: TypeScript, TSX, JavaScript, Python, Go, Rust, Ruby, Java, Kotlin, Swift. Any other file is cut into hunks | every language | every language |
| What the agent is handed | the one function at fault | the hunk the fault sits in | up to 12,000 bytes of diff |
| Pieces, 172 changes | 643 | 532 | 172 |
| Jev requests, 172 changes | 247 | 214 | 172 |
| Input tokens, 172 changes | 490,231 | 433,421 | 269,307 |
| Pieces, calls and tokens on `cutting.diff` with one rule | 4 pieces, 1 call, 1,042 in and 80 out | 1 piece, 1 call, 569 in and 23 out | 1 piece, 1 call, 569 in and 23 out |
| Real breaks caught at 0.5, of 21 | 11 | 14 | 9 |
| Disputed flags at 0.5 | 26 | 16 | 6 |
| Real breaks caught at 0.6, of 21 | 5 | 8 | 5 |
| Disputed flags at 0.6 | 14 | 2 | 0 |
| A file that will not parse | reported as not checked, never checked half way | checked, nothing parses it | checked, nothing parses it |
| A file whose grammar is not installed | reported once as not checked, with the command to fix it | not possible | not possible |

An earlier run of the same test, with four of the rules and truth corrected by an adjudicator
over 29 real breaks, put the three modes in the same order at 0.5: one hunk per piece caught
22 with 5 plainly false flags, tree-sitter pieces 16 with 4, and big chunks 12 with 0.

What each one is bad at, plainly:

- **`hunks`**: a new file is one giant hunk, so it gets cut blindly every 30 added lines with
  no regard for where a function starts or ends. Two functions that sit next to each other
  share a hunk. A hunk can start in the middle of a function, so the agent is handed a piece
  of code with no head.
- **`functions`**: it needs the grammar files, which are megabytes in the repository, and it
  only knows the ten languages listed above. A file it cannot parse is not checked at all.
- **`chunks`**: one bad line is diluted in a big diff, which is the quietest setting of the
  three and the one that misses most at a low bar, and the agent is handed a large diff to
  search.

The parse behaviours are worth seeing for real. A file with broken syntax and a `.sql` file,
in functions mode:

```
stop-rules: no rule violations in your latest changes.

Not checked (1): broken.ts lines 1-5: could not be parsed as TypeScript
```

```json
"cutByHunk": [ { "file": "schema.sql", "reason": "no grammar for .sql" } ]
```

The same repository in hunks mode checks the broken file and finds the fault in it:

```
1. broken.ts lines 1-5 breaks 1 rule
   Rule: Do not silently swallow errors. ...
   Confidence: 0.95
```

## 3. Rules

Rules are not in `.stop-rules.json`. They are in `.stop-rules.md`, one top-level list item
each, and they are the knob that changes the most. Every rule adds one question per piece.

### Four wordings, one change

[`rules-demo.diff`](../examples/tuning/rules-demo.diff) adds a retry helper with a narrating
comment, a local variable nothing reads, and an option nothing uses.

```bash
stop-rules score --diff examples/tuning/rules-demo.diff --rules examples/tuning/rules-with-examples.md
```

| Rules file | The rule | Score |
|---|---|---|
| [`rules-with-examples.md`](../examples/tuning/rules-with-examples.md) | Do not write comments that only restate what the code does, or that narrate the change being made ("now we also handle X", "fixed the bug where"). A comment that explains why the code must be this way is fine. | 0.89 |
| [`rules-terse.md`](../examples/tuning/rules-terse.md) | No useless comments. | 0.28 |
| [`rules-linter.md`](../examples/tuning/rules-linter.md) | Do not leave a variable that nothing reads. | 0.57 |
| [`rules-codebase.md`](../examples/tuning/rules-codebase.md) | Do not add configuration options, parameters or abstractions that nothing in this change uses. | 0.62 |

The same comment, in the same change, is a 0.89 under the long rule and a 0.28 under the
short one. The examples inside the rule are doing the work.

The linter rule scores 0.57 on a variable that really is unused. ESLint's `no-unused-vars`
gives you the same answer for nothing, every time, with the line number. Paying a Jev
question for it buys you a maybe.

The codebase rule scores 0.62 on an option that nothing in the piece uses. Whether anything
in the repository uses it is a question this piece cannot answer, so a score like that is a
guess dressed as a number.

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
| [3](../examples/tuning/rules-three.md) | 3 | 1 | 657 | 61 |
| [12](../examples/tuning/rules-twelve.md) | 12 | 1 | 1,078 | 234 |

Four times the rules is not four times the cost, because the piece is sent once and the rules
ride along with it. It is about 1.6 times the input tokens here. Five to fifteen rules is the
range we would stay in, for noise rather than for money.

## 4. Calls per run: `maxCalls`

One run sends at most this many requests to Jev, counted across retries and splits. `60` is
the default, which is far more than a normal turn needs: four pieces ride in one request, so a
change of forty functions is ten requests.

When the budget runs out, the work left over is reported and nothing pretends it was checked.
Ten new functions with a budget of one request:

```bash
stop-rules check --max-calls 1
```

```
stop-rules: no rule violations in your latest changes.

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
{"mode":"check","cut":"functions","pieces":10,"calls":1,"cacheHits":0,"notChecked":6}
{"mode":"check","cut":"functions","pieces":10,"calls":2,"cacheHits":4,"notChecked":0}
```

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

At $0.042 per million input tokens, and output free, from our own measured runs:

| What was measured | Input tokens | Cost |
|---|---|---|
| One 19 line file, one rule, cut into functions (4 pieces) | 1,042 | $0.00004 |
| The same file, cut into hunks or chunks (1 piece) | 569 | $0.00002 |
| The same file with 3 rules | 657 | $0.00003 |
| The same file with 12 rules | 1,078 | $0.00005 |
| All 240 sample changes, cut into functions | 668,891 | $0.028 |
| All 240 sample changes, cut into chunks | 383,892 | $0.016 |
| 172 of them, cut into hunks | 433,421 | $0.018 |

Per change, cutting into whole functions, the sample averages 2,787 input tokens, which is
$0.00012. A thousand agent turns of that size cost about 12 cents. Going from 3 rules to 12
raised the input tokens by about 60 percent on our one piece test, and a second run over the
same code is free because the answers are cached.

Latency, from the same runs: the median change took 203 ms of Jev time cut into functions and
192 ms cut into hunks or chunks. The check itself adds the git snapshot and the parse, so a
blocking hook feels like about a second.

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
- **Three rounds.** After three turns of the same findings the tool stops waking the agent
  and leaves them for you. An agent that has not fixed something in three tries is not going
  to.
- **Lines longer than 1,000 characters are left out of the piece,** with a marker in their
  place. They are minified bundles and base64 blobs, they cost a fortune in tokens, and no
  coding rule is about them.
- **Lock files, minified bundles, maps, snapshots, logs, CSV and TSV files, SVGs and binaries
  are skipped,** and `check --json` lists what was skipped and why.
