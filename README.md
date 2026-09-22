# stop-rules

`stop-rules` holds your coding agent to your team's written coding rules. When the agent
finishes a turn, it cuts the code changed since the last check into pieces, one git diff hunk
each, and asks [Jev](https://typesafe.ai) one yes or no question per piece and per rule, with 25
lines of the surrounding file so the question can be answered. If a rule is likely broken, it
hands that piece of code back to the agent so it fixes it before you see it. Jev is the default
judge; OpenAI's `gpt-6-luna` is the other one, see [Which judge](#which-judge).

Cutting by git diff hunk is the default, and it needs nothing installed. A team that would
rather have one whole function per piece switches to tree-sitter with
`init --cut functions`, which is 10 languages and a few megabytes of grammar files. Both are
in [docs/TUNING.md](docs/TUNING.md).

Using a coding agent? Point it at [AGENT-SETUP.md](AGENT-SETUP.md) and let it do the
install.

## Quick start, just you

```bash
git clone https://github.com/haystackeditor/stop-rules
node stop-rules/bin/stop-rules.mjs init --dir /path/to/your/repo
```

No `npm install`, no build: `bin/stop-rules.mjs` is committed and ready to run.

`init` finds which coding agents your repo already uses, copies itself into
`.stop-rules/stop-rules.mjs` there, writes a starter `.stop-rules.md`, and wires the hook into
each agent's own config file. That is one file of 390 KB and no grammar files at all, because
cutting by git diff hunk parses nothing. It says so:

```
  cutting by git diff hunk, no grammar files needed (.stop-rules is 0.4 MB)
  run init --cut functions to cut by whole function with tree-sitter
```

Then:

```bash
cd /path/to/your/repo
printf %s "$JEV_KEY" | node .stop-rules/stop-rules.mjs login --jev-key-stdin
node .stop-rules/stop-rules.mjs login --check
```

Edit `.stop-rules.md` so it says what your team cares about, then commit `.stop-rules.md`,
the `.stop-rules/` folder and the agent config files. Your key is not in any of them: it
lives in `~/.config/stop-rules/jev-key`, mode 0600.

`.stop-rules/` holds the checker, one file. Commit it and teammates and cloud agents get the
check with nothing to install.

If you ran `init --cut functions`, that folder also holds the parser and one grammar file per
language your repo uses, so it is a few megabytes. Commit those too. If you would rather not
have binaries in git, leave the grammars out and each person runs `init` again on their own
machine; a language whose grammar is missing is reported as not checked and nothing else
breaks.

## Quick start, a team

One person deploys a small server that holds the Jev key. Nobody else needs the key.

1. Deploy the server. [DEPLOY.md](DEPLOY.md) has a row per cloud, fastest first, and the
   two secrets every one of them needs.
2. Point the repo at it, once, and commit the file it writes:

   ```bash
   node /path/to/stop-rules/bin/stop-rules.mjs init --dir /path/to/your/repo \
     --team https://your-endpoint.example.com
   ```

3. Every teammate runs one line, once per machine:

   ```bash
   printf %s "$STOP_RULES_TOKEN" | node .stop-rules/stop-rules.mjs login --token-stdin
   ```

Share the team token through your password manager, not in a repo or a chat.

## You bring your own Jev key

Jev is TypeSafe's service. You need your own API key from them; we do not provide one and
there is no offline mode. In team mode the key sits on your server, so developers only need
the team token. A repo on the OpenAI judge needs an OpenAI key instead, in the same places.

## Which judge

Two services can score the pieces. **Jev** is the default: TypeSafe's scoring service, asked for
a probability per piece and per rule, up to four pieces per call. The other is **OpenAI's
`gpt-6-luna`** through the Responses API with strict JSON output. Everything else is the same
with either judge: the cutting, the 25 lines around each change, the bar, the cache, the report,
the hooks and team mode.

The OpenAI judge has two forms. The default is the **review form**: one call per change, with
every piece of the change in it, each piece's diff and its 25 lines around it grouped under its
file, then your rules. The model reviews the change and reports every rule the added lines break,
as `{"findings": [{"ruleId", "line", "reason", "confidence"}]}`, where `line` is the offending
added line quoted verbatim and `confidence` is `sure`, `likely` or `unsure`. The tool turns that
into a score per piece and rule, sure 1.0, likely 0.75, unsure 0.5, not reported 0, so at the
default bar of 0.6 a sure or likely finding counts and an unsure one does not. The agent is handed the quoted line and the model's one
sentence reason under each rule, so it sees where:

```
   Rule: Do not silently swallow errors. ...
   Confidence: 1.00 (sure)
   Line: } catch {
   Why: The empty catch discards the error and returns `null` as though no failure information needs to be preserved.
```

A finding that names a rule your repo does not have, or quotes a line the change did not add
(compared after trimming whitespace and a leading `+`), is refused on its own. It gets one line
under "Findings rejected" in the report, is counted in `check --json` as
`stats.rejectedFindings`, and the rest of the answer still counts. It never fails the run.

The other is the **scores form**, `"form": "scores"`: one call per piece, one probability per
rule, the same question Jev is asked. It is what the tool shipped first and it stays for anyone
who wants it.

To switch a repo to OpenAI, run this and commit the `.stop-rules.json` it writes:

```bash
node .stop-rules/stop-rules.mjs init --judge openai
printf %s "$OPENAI_API_KEY" | node .stop-rules/stop-rules.mjs login --openai-key-stdin
node .stop-rules/stop-rules.mjs login --check
```

That puts `"judge": {"kind": "openai", "form": "review", "model": "gpt-6-luna", "effort": "low"}`
in `.stop-rules.json`. `{"kind": "jev"}`, or no `judge` key at all, is Jev. `effort` is how long
the model reasons before it answers: `none`, `low`, `medium` or `high`, and `low` is the default.
`--judge`, `--model` and `--effort` on any command beat the file for that run. The key comes from
`OPENAI_API_KEY`, from `OPENAI_API_KEY_FILE`, or from the file `login --openai-key-stdin` writes
next to the Jev key, mode 0600. In team mode the server holds it instead, as `OPENAI_API_KEY`
(see [DEPLOY.md](DEPLOY.md)).

The judges never mix. The cache key holds the judge, the model, the effort and the form, so an
answer from one is never read as an answer from another. Nothing switches judge on its own: a
missing key, a rejected key, a model your key cannot use, or an answer that breaks the schema
stops the run with one line, and the baseline stays where it was.

What the trade looks like. Measured on 22 September 2026 on the same 240 real agent written
changes (the six starter rules, 32 real breaks after the latest adjudication), at a bar of 0.5,
the bar the comparison was run at, not the tool's default of 0.6. Time and money are per change,
the way a stop hook sees one turn: the time is the median of the calls one change needed, and the
money is what all 240 changes cost.

| Judge | Real breaks caught, of 32 | Plainly false flags | Arguable flags | Flags nobody has ruled on | AUC | Median time per change | Dollars, 240 changes |
|---|---|---|---|---|---|---|---|
| Jev | 20 | 10 | 5 | 11 | 0.977 | 193 ms | $0.027 |
| gpt-6-luna, review form, effort low | 31 | 10 | 13 | 38 | 0.974 | 2,643 ms | $0.059 |
| gpt-6-luna, review form, effort low, 25 lines around each piece | 31 | 12 | 13 | 31 | 0.975 | 3,243 ms | $0.095 |
| gpt-6-luna, scores form, effort low | 29 | 17 | 9 | 52 | 0.950 | 6,406 ms one call after another, 3,081 ms with a change's calls at once | $0.147 |

How to read it. The review form at effort low caught 31 of 32 where Jev caught 20, with the same
10 plainly false flags; more of its flags nobody has ruled on yet. It ranks about as well as Jev
(AUC 0.974 against 0.977). Of the 31 real breaks it caught, the line it quoted was the line the
reviewer had pointed at for 27. It invented a quote once in 198 findings. It is slower than Jev,
about 2.6 seconds a change against 0.2, and costs about twice as much, 6 cents for all 240
changes. The scores form caught fewer, flagged more wrongly and cost more, because it asks once
per piece.

The first review row was shown each change's whole diff; the second, the diff with 25 lines around
each piece, which is what the tool sends. The review form at effort medium caught the same 31 with
16 plainly false flags, for $0.086 and 3,283 ms a change. Effort high was never measured.

On the demo turn in this repo's examples, measured with this build, five runs each with the
answer cache deleted first, the whole `check` took a median 3.61 s on the broken turn with the
review form, exit 2 all five times with the three right lines quoted, and 1.17 s on the repaired
turn, exit 0 all five times. Jev took 0.57 s and 0.55 s. The knobs and what each one costs are in
[docs/TUNING.md](docs/TUNING.md#8-the-judge-judge).

## Which agents are supported

`init` writes the hook for every agent it finds in the repo. What happens next depends on
what that agent's hook system can do.

| Agent | On a broken rule | How well tested |
|---|---|---|
| Claude Code | told to fix it | ran for real, `claude -p` with the hook installed |
| Codex | told to fix it | simulated hook input only, matches its docs |
| Cursor | told to fix it | simulated hook input only, matches its docs |
| Gemini CLI | told to fix it | simulated hook input only, matches its docs |
| GitHub Copilot CLI | told to fix it | simulated hook input only, matches its docs |
| Factory Droid | told to fix it | simulated hook input only, matches its docs |
| Kiro | told to fix it | simulated hook input only, matches its docs |
| OpenCode | told to fix it | generated plugin file, type checked, never run in OpenCode |
| Amp | told to fix it | generated plugin file, type checked, never run in Amp |
| Pi | told to fix it | ran for real, `pi --mode json` with the extension installed |
| Aider | told to fix it, as lint output | simulated run only, matches its docs |
| Windsurf Cascade | shown to you only | simulated hook input only, matches its docs |
| Cline | shown to you only | simulated hook input only, see the note below |
| plain | prints the report, exit 2 | used by the OpenCode and Amp plugins and the Pi extension |

Only Claude Code can run the check in the background and still reach the agent. Every other
agent runs it as a normal blocking hook, which takes about a second.

Cline is the one case where the documentation disagrees with itself. Its hooks README
documents the `TaskComplete` hook, the file it lives in and the JSON it must answer with,
and the same README marks that event "coming soon!". The file is written to the documented
contract, so if your Cline never runs it, that is why.

Pi loads a project extension only once you trust the folder. In the terminal it asks.
`pi --print` and `pi --mode json` cannot ask, so pass `--approve` or save the decision once
with `/trust`. Without either, Pi skips the extension and says nothing: measured on 22
September 2026 with Pi 0.87.1, an untrusted `pi --print` run over a change that breaks three
rules exited 0 and never started the check.

## Which languages it can cut into pieces

Every language, by default. A change is judged one piece at a time, and by default a piece is
one git diff hunk, which needs no parser and no grammar file.

A piece can be one whole function instead, with `--cut functions` or `"cut": "functions"`. That
needs a parser, so these are the languages it has one for:

<!-- languages -->
| Language | File extensions |
|---|---|
| TypeScript | `.ts`, `.mts`, `.cts` |
| TSX | `.tsx`, `.jsx` |
| JavaScript | `.js`, `.mjs`, `.cjs` |
| Python | `.py` |
| Go | `.go` |
| Rust | `.rs` |
| Ruby | `.rb` |
| Java | `.java` |
| Kotlin | `.kt`, `.kts` |
| Swift | `.swift` |
<!-- /languages -->

In that mode any other file is cut by diff hunk instead, which works and is a little blunter.
`check --json` says which files that happened to and why.

## Writing good rules

`.stop-rules.md` is Markdown. Every top-level list item is one rule. Indented lines and
nested bullets belong to the rule above them. Headings, paragraphs and code blocks are
ignored, so you can paste an existing guidelines document and keep its structure.

Two things decide whether a rule works here:

- If a linter can check it, use the linter, not a rule in this file.
- A rule must be something a reviewer could judge from one piece of a change, without
  seeing the rest of the codebase.

Then write each rule as one checkable sentence that says what to do instead:

```markdown
- Do not silently swallow errors. When code catches or receives an error it must rethrow
  it, return it to the caller, log it with enough context to debug, or store it on a
  result or record the caller can read. The break is a catch that drops the error and
  carries on as if nothing happened: an empty catch block, a catch that only says
  "ignore", or a top-level catch that exits without saying what failed. A test that
  catches an error it expects, to assert on it, is not covered.
- Do not leave stubs, placeholders, TODO implementations or fake data in code that is
  presented as finished. The break is a function that returns a canned value or throws
  "not implemented", a TODO where the real code should be, or sample data wired in as if
  it were real. A test double inside a test file is not covered, and an interface or type
  with no body is not a stub.
```

Rules that work less well are the vague ones ("write clean code") and the ones about things
one piece of a change cannot show ("keep the service boundaries tidy").

The full checklist a coding agent follows when it writes or reviews rules is
[AGENT-SETUP.md, section 6](AGENT-SETUP.md#6-write-the-rules-from-the-teams-own-documents).
Three edits that were measured to matter, twice. First on the 96 saved agent sessions
described below: rewording 14 of 48 rules in only these three ways, with nothing else
changed, took the real breaks caught from 48 of 59 to 56 of 62 and the false alarms from 35
to 26. Then on 48 fresh Haiku sessions the wording had never seen, with the reworded rules
live in the hook: 27 of 34 real breaks caught (79%) with 10 false alarms, against 34 of 58
(59%) with 10 false alarms for the original wording on the original Haiku sessions.

- Say what the rule means for tests. "Never call `fetch` outside `http.ts`; a test may call
  it against a server the test starts." Most of the wrong flags we saw were on test files the
  rule had not thought about.
- If a rule is about a layer, name the folder. "Files under `lib/controllers/` must not
  build SQL" gives Jev a fact it can see in the path. "Controllers must not build SQL" makes
  it guess which files are controllers. Layer rules went from 8 false alarms to 3.
- Turn a soft clause into a concrete ban. "The `Money` helpers do the arithmetic" caught 0 of
  3 real breaks. "Never add, sum, multiply or take a percentage of cents values with plain
  arithmetic outside `lib/money.rb`; call `Money.sum_cents`, `Money.percent_of` instead"
  caught 3 of 3, and found 2 more nobody had noticed. Jev sees the ban, not the intent.

### Which kinds of rule Jev can judge, measured

Six small projects were written for this, one each in Ruby, Python, Go, Rust, React and a
near-empty TypeScript seed. Each had 8 team rules the agent never saw and 8 tasks, each task
run once with Sonnet and once with Haiku in a real Claude Code session with the hook live: 96
sessions on 20 and 21 September 2026. A blind reader wrote the answer key before any score
was looked at, and a second reviewer ruled on every flag outside the reader's files, so
nothing below is a false alarm by default. Full write-up and every n in
[docs/TUNING.md](docs/TUNING.md).

The tool's own output at its own bar, all 96 sessions: the agents broke a rule 59 times
unprompted, the tool pointed at 43 of them in the right file and 5 more in the wrong file,
missed 11, and raised 18 flags a reviewer ruled not a break plus 10 arguable ones. The whole
thing cost $0.07 in Jev calls. Haiku broke a rule in 30 of its 48 sessions, Sonnet in 11.

| kind of rule | rules | real breaks | caught | missed | false alarms | arguable |
|---|---|---|---|---|---|---|
| never call X, use Y | 24 | 35 | 30 | 5 | 5 | 3 |
| layer or folder | 8 | 7 | 7 | 0 | 9 | 2 |
| something must be present | 6 | 7 | 6 | 1 | 2 | 1 |
| needs another file | 6 | 5 | 5 | 0 | 0 | 3 |
| a value's format | 3 | 3 | 0 | 3 | 0 | 0 |
| judgment | 4 | 2 | 0 | 2 | 2 | 1 |

"Caught" here includes the 5 flagged under the right rule in the wrong file.

- **Works: "never call X, use Y instead", where X is a name the code shows.** Most of the
  rules, most of the breaks, most of the catches, about one false alarm in seven flags. Our
  own example agrees: [`helper.diff`](examples/tuning/helper.diff) scores 0.92 on the function
  that calls `fetch` and 0.10 on the one that calls the helper.
- **Careful: a rule about which layer or folder a file is in.** Every break was caught, and
  there were more false alarms than catches. Every false alarm was a flag on a file outside
  the layer the rule restricts: a model, the composition root, a README. Name the folder the
  rule applies to and Jev has the fact it needs.
- **Careful: tests.** 12 of the 28 wrong or arguable flags were on test files where the rule
  said nothing about tests. Say what the rule means for tests.
- **No evidence it works: a rule about a value's format** ("timestamps are ISO 8601 in UTC").
  0 of 3 caught. Three is a small number, but it is all we have.
- **Does not work: a rule that needs the rest of the codebase**, because a piece and the code
  around it is all Jev sees.
- **The honest headline.** Where the code already follows the rules and the task extends
  it, the agents mostly followed the rules by copying what they saw (Rust: 2 breaks in 16
  sessions). The tool earned its keep in two places: old code that already breaks the rules
  (Go: 17 breaks in 16 sessions, 16 pointed at), and new subsystems or a bare seed with
  nothing to copy from (39 breaks across the six projects' new-subsystem tasks, 33 pointed
  at).

## How it works

1. **What changed.** The working tree is written to a git tree object through a temporary
   index, so your own index and staged changes are never touched. That snapshot is diffed
   against the tree from the last check, so each turn only pays for new work.
2. **Pieces.** The diff is cut into pieces, one git diff hunk each. Nothing is parsed, so
   every language is covered and a file that will not parse is still checked. A hunk with more
   than 30 added lines is cut right after the 30th, taking up to 3 trailing context lines with
   it. Lock files, minified bundles, data and log files, binaries and deletions are skipped.
   `"cut": "functions"` turns the parser on instead: a function, method, constructor or
   accessor is then always a piece of its own, whatever its size, everything else groups with
   its neighbours up to 40 added lines, and a file with no grammar falls back to diff hunks.
   `"cut": "chunks"` groups a file's hunks into pieces of up to 12,000 bytes, also with no
   parser. See [docs/TUNING.md](docs/TUNING.md) for what you gain and lose by switching.
3. **The code around each piece.** A piece on its own is often too little to judge, so the
   diff that goes to Jev carries 25 unchanged lines above the change and 25 below, read out of
   the snapshot. In `"cut": "functions"` a piece that is one function carries that whole
   function after the change instead, and a piece that is not a function is widened only into
   lines no other piece of that file owns. This is only what Jev is shown: the report still
   hands the agent the piece.
4. **One yes or no score per rule.** Every piece is asked about every rule: does the added
   code break this rule. Jev answers each claim with a probability. At or above the cutoff
   (0.6 by default) it is a finding. Up to four pieces ride in one request, and a request is
   also bounded at 60,000 bytes, so a normal turn is one or two requests.
5. **Tell the agent.** One entry per piece: the file, the line range, the name of the function
   when there is one, then every rule that piece broke with its score, and then the piece's
   diff once. The agent gets the code that broke the rule, not a line number to go and find.

### What Jev sees

Measured on our harness on 20 September 2026, at the default bar of 0.5, over the same 240
real agent written changes, blind labelled and adjudicated, which hold 31 real breaks:

| What Jev was shown | Real breaks caught, of 31 | Plainly false flags | Flags nobody has ruled on |
|---|---|---|---|
| the piece alone, which is what it sent before | 23 | 10 | 23 |
| the piece with 25 lines around it, no parser | 21 | 7 | 13 |
| the whole function, with tree-sitter | 21 | 10 | not counted |

The middle row is what ships. It catches two fewer and argues with you a lot less, it needs no
parser, and at a bar of 0.55 it caught 16 with fewer doubtful flags than either of the others.
The measurement was on hunk pieces, so in `functions` mode, where a piece can be two lines, the
window of a piece that is not a function stops at the first line another piece owns. Without that
clamp two import lines in a 19 line file scored 0.84 on the swallowed errors rule, on a
neighbour's fault; [docs/TUNING.md](docs/TUNING.md) has that example in full.
On a second, smaller set of real agent sessions it caught 2 of the 3 real breaks against 1 for
the piece alone, and it found a missing doc comment that the piece alone missed. The cost of
the extra lines: 7 of 1,358 clean pairs were newly flagged, and input tokens go from about
$0.11 to $0.21 per 1,000 changes at TypeSafe's published price.

Two things we tried and did not build, so nobody spends the time again:

- **Asking Jev whether it needs more information.** It answered "not enough" to 98% of the
  questions, and its answer had no relation to whether more context changed the score (AUC
  0.27). There is no signal there to act on.
- **Widening only where that question asked for it.** 2 to 4 times the calls, and no gain over
  widening every piece.

Also measured: sending the whole file when it is small looked good where it applied, but 57% of
the real pieces come from files over 12 KB, so it does not apply often enough to build.

Because the claim and the piece text both changed, every cached answer from an older version is
a miss: after upgrading, each piece is asked once more. See the changelog at the end.

### Where the report comes out, per agent

Measured on 19 September 2026 by feeding each adapter the payload its own agent documents,
and for Pi on 22 September 2026 the same way.
When a rule is broken:

| Agent | Where the report goes | Exit code |
|---|---|---|
| Claude Code, Codex, Gemini CLI, Factory Droid, Windsurf Cascade | stderr | 2 |
| OpenCode, Amp, Pi, plain | stdout and stderr, the same text on both | 2 |
| Aider | stdout, as lint output | 2 |
| Cursor | stdout, as JSON in `followup_message` | 0 |
| GitHub Copilot CLI, Kiro | stdout, as JSON in `reason`, next to `"decision": "block"` | 0 |
| Cline | stdout, as JSON in `contextModification` | 0 |

Read that before you wrap the hook in anything. A wrapper that captures only stdout loses
the entire report for the five agents that write it to stderr, and four of the fourteen
deliver a report while exiting 0, so an exit code alone does not tell you whether the turn
was clean. On a clean turn every adapter exits 0 and writes nothing, except Gemini CLI and
Cursor, which write `{}`, and Cline, which writes `{"cancel":false}`.

`check` is the one to use in a script: it prints its report on stdout and exits 2 when a
rule is broken.

### Quiet is not the same as clean

It never nags twice: a finding the hook has already delivered in this repo is not delivered
again. A second run over the same code costs nothing, because every answer is cached in the
repo's git directory, keyed on the model, the exact claim and the exact text Jev was sent,
which includes the lines around the change. Packing does not change that key, so re-packing
never throws answers away. And every run has a hard
ceiling on requests (60 by default, `--max-calls`), counted across retries and splits. When
it runs out, the work left over is reported as "not checked".

That cuts both ways, and it is worth being plain about. The hook tells the agent once. If
the agent decides the rule does not apply and changes nothing, the next turn is silent while
the code still breaks the rule, so a quiet hook is not a clean codebase. In our own
experiment on 19 September 2026, 3 of 16 sessions ended that way: the agent argued and
changed nothing, the hook stayed quiet, and `check --base HEAD` still reported the finding.
Across the six projects and 96 sessions of 20 and 21 September, 13 sessions ended that way.
`check --base <rev>` is the honest gate, because it is read only, skips nothing it has
already told an agent about, and reports the same finding every time you run it. It also has
no way to mark a finding as accepted, so a false alarm keeps coming back there until you
reword the rule or change the code.

The first line of a report is picked from the facts, so it never claims more than was done:
nothing changed since the last check, the change was checked and no rule was broken, part of
it was checked and part was not, or something changed and none of it could be checked. The
last one, for example a repo in `functions` mode with no TypeScript grammar installed, is a
could not run in hook mode: exit 1 with the reason, not silence, because silence reads as
clean. Measured on 19 September 2026, in a repo whose `.stop-rules.json` says `functions` and
that has no grammar files:

```
stop-rules: 1 file changed and none of it could be checked.
This does not say your code is clean. The reasons are below.

Not checked (1): no grammar installed for .ts, run stop-rules init again to add it
```

### Why the default bar is 0.6, and how to pick yours

It is a default to look at, not a recommendation. `"threshold"` in `.stop-rules.json`, or
`--threshold`, sets it to anything from 0 to 1.

How to pick your own bar, and why there is no single right number: the bar trades catches
for noise, and where you want to sit on that trade depends on how much your team minds a
wrong flag against a missed break. Measured on 96 agent sessions across six projects with
well-worded rules (one piece per call, every flag ruled by a reviewer):

| Bar | Real breaks caught, of 62 | Wrong flags | Arguable flags |
|---|---|---|---|
| 0.5 | 59 | 13 | 4 |
| 0.6 | 56 | 5 | 2 |
| 0.7 | 46 | 2 | 1 |

Going from 0.6 down to 0.5 buys 3 more catches for 8 more wrong flags. Going up to 0.7 loses
10 catches to remove 3. Below 0.5 is not worth it: the 93 extra flags between 0.4 and 0.5
held 1 real break. The numbers move with the model version and with your rules, so before
you settle on a bar, run `stop-rules score` on a few of your own recent changes and look at
where the real problems and the noise land.

The earlier measurement, on 240 real agent written changes with the original rule wordings,
had a steeper trade: 0.5 caught 22 of 29 with 6 plainly false flags, and 0.6 caught 11 with 1.
Well-worded rules (see "Writing good rules") are what flattened it, and a team whose rules are
still rough may prefer 0.5. A team that would rather be told less puts `"threshold": 0.7` in
`.stop-rules.json`. A later scoring run of the same sample, with all six starter rules and no
adjudication, gives lower counts and the same shape; both runs, every bar from 0.3 to 0.7, and
every cut mode are in [docs/TUNING.md](docs/TUNING.md). Run `stop-rules score` on your own code
before you settle on a bar.

### Not spamming Jev

Jev's rate limit is per account, so a whole team shares it and so does every tool on your
machine. Three things keep this one polite:

- One run keeps at most 4 requests in flight. On the OpenAI judge that is `"inFlight"` in the
  judge setting, 4 by default, 1 to 8.
- Every stop-rules process on the machine shares 8 slots per judge, held as lock files in your
  cache folder. If they are all busy for a minute the run stops and says so, and the same
  change is checked on the next turn.
- A 429 halves the in-flight ceiling, waits as long as `Retry-After` says, and earns one slot
  back after four answers in a row.

### How accurate is it

Small samples, and worth knowing before you trust it. The sample is 240 real agent written
changes from 104 public repositories, labelled blind by reviewers. There are 32 real breaks in
it, across the six starter rules.

Every count in this section was measured with the piece alone, before Jev was given the code
around it. The comparison that led to the change is in "What Jev sees" above: at the default
bar the wide form caught two fewer real breaks and raised three fewer plainly false flags. So
read what follows as the shape of the thing on the same sample, not as this build's score.

- **At the defaults**, one hunk per piece at 0.5, over the 172 of those changes that mode was
  scored on and the 21 real breaks in them: 14 of 21 caught, and 16 flags the reviewers did not
  agree with. On the same bar and the same 172 changes, whole functions caught 11 of 21 with 26
  disputed flags, and chunks 9 of 21 with 6.
- **The adjudicated run of the same sample**, four of the rules and 29 real breaks, is where
  the default bar comes from: one hunk per piece caught 22 of 29 at 0.5, with 6 plainly false
  flags and 5 arguable, and 11 of 29 at 0.6, with 1 plainly false flag.
- **Whole functions over all 240 changes** and their 32 real breaks: 20 of 32 caught at 0.5
  with 38 disputed flags, and 10 of 32 at 0.6 with 19. Of those 19, an adjudicator had earlier
  called 5 plainly not a break and 2 arguable; the other 12 nobody has ruled on. Chunks at 0.6
  caught 9 of 32 with 1 disputed flag.
- On planted examples, measured earlier: stubs 20 of 20, hardcoded test values 12 of 20, and
  0 of 40 harmless look-alikes flagged.

Those come from one scoring run per cut mode. Asked seven times, a confident score moved by a
hundredth or two and a borderline one moved from 0.45 to 0.80, so the counts near a bar would
move a little in another run.

Either way it misses things: two thirds of the real breaks on the low count, a third on the
high one. Scores also move between Jev model versions, so run `stop-rules score` on your own
code and see. Every number above, per rule and per bar, is in
[docs/TUNING.md](docs/TUNING.md).

## What leaves your machine

Sent to Jev, per request: up to four pieces of your diff, the path of the file each one came
from, 25 unchanged lines of that file above and below each change (or, in `functions` mode, the
whole function the change sits in), and the text of your rules. Nothing else: no repo name, no
history, no file the diff does not touch. In team mode the same request goes to your own server, which adds the Jev key
and forwards it.

Sent to OpenAI, when the judge is openai, per request: in the review form, every piece of the
change with the same lines around it and the path of each file, your rules and the fixed
instruction; in the scores form, the same things for one piece, plus a `prompt_cache_key` that
is a hash of the instruction and your rules. Both send `"store": false`, which asks OpenAI not
to keep the response. In team mode it goes to your
server first, which forwards only those fields with its own key.

Kept on your machine and never committed, in `<git dir>/stop-rules/`: `state.json` (the
baseline tree, which findings were delivered, per-session counters), `cache.json` (claim
hashes and their scores), `run.log` (one JSON line per run, capped at 1 MB) and `lock`. The
machine wide slots are small files in your cache folder (`$XDG_CACHE_HOME/stop-rules/slots`,
or `~/Library/Caches/stop-rules/slots` on a Mac, and `openai-slots` beside it for the OpenAI
judge), each holding a process id and a time. Your
key or token lives in `~/.config/stop-rules/` with mode 0600. Neither is ever written into
the repo, printed, or included in an error message.

## Commands

```
stop-rules init [--dir <repo>] [--agents a,b,c] [--team <url>] [--cut <mode>] [--judge <kind>] [--json]
stop-rules check [--dir <repo>] [--base <rev>] [--json]
stop-rules score [--dir <repo>] [--base <rev>] [--diff <file>] [--show-context] [--json]
stop-rules hook [--dir <repo>] --agent <name>
stop-rules team [--dir <repo>] <url>
stop-rules login --jev-key-stdin | --openai-key-stdin | --token-stdin | --check [--dir <repo>]
stop-rules serve [--port n]
stop-rules baseline --reset [--dir <repo>]
```

- **init** installs into a repo. `--dir` picks the repo, `--agents` overrides detection,
  `--team` switches the repo to team mode, `--cut functions` adds the parser and the grammars
  for the languages the repo uses and writes `"cut": "functions"` into `.stop-rules.json`,
  `--judge openai` (with `--model` and `--effort` if you want others than the defaults) writes
  the judge into `.stop-rules.json`, `--json` prints the same facts for an agent to read.
- **check** runs the same pipeline in a terminal, for a pre-commit hook or CI. `check`
  prints its report on stdout and exits 2 when a rule is broken. Exit 0 clean, 2 findings,
  1 could not run. With `--base <rev>` it diffs that revision against your working tree;
  without it, it uses the incremental baseline but never moves it, so it is safe to repeat.
- **score** prints every piece with every rule's score and applies no cutoff, so you can see
  where your own code sits before you pick a bar. It changes nothing. `--diff <file>` scores
  a unified diff file instead of the working tree; a diff file has no file content, so there
  are no lines around a change to send and the output says so. `--show-context` prints exactly
  what the judge saw for each piece, which is the way to see the 25 lines for yourself. The
  header names the judge and its model.
- **hook** is what the agents call. `--agent` says whose protocol to speak.
- **team** writes the endpoint into `.stop-rules.json`. Commit that file.
- **login** stores your Jev key, your OpenAI key or your team token, read from stdin so it
  never lands in shell history. `--check` calls your server's health route and makes one real
  call to the judge this repo is set to.
- **serve** runs the team server on a laptop or a plain VM.
- **baseline --reset** forgets what was checked, so the next run starts from HEAD.

Shared flags: `--dir <path>` (the repository to work on), `--rules <path>` (default
`<repo root>/.stop-rules.md`), `--cut <mode>` (default hunks), `--threshold <0..1>`
(default 0.6), `--max-calls <n>` (default 60, and 240 for the OpenAI scores form, which asks
once per piece), `--judge jev|openai`, `--model <name>` and `--effort <level>` (the OpenAI judge
only), `--help`, `--version`.

Which repository a command works on is one rule: `--dir` when you give it, and otherwise the
repository that holds the folder you are in. The copy of stop-rules that `init` vendors into
a repository works on that repository only; run it from somewhere else and it stops, names
both repositories and tells you to pass `--dir` or change folder. Use the clone's
`bin/stop-rules.mjs` to install into a different repository.

## Settings, and tuning

`.stop-rules.json` in your repository root is the one place a team sets the knobs. It is
committed and holds no secret. Every key is optional, and a flag beats the file.

```json
{
  "endpoint": "https://stop-rules.your-team.example.com",
  "cut": "hunks",
  "threshold": 0.6,
  "maxCalls": 60,
  "judge": {"kind": "jev"}
}
```

Those are the defaults for the knobs that have one, so a file like that changes nothing.
`judge` is `{"kind": "jev"}` or `{"kind": "openai", "form": "review", "model": "gpt-6-luna",
"effort": "low", "inFlight": 4}`, where `form` is `review` or `scores`; see
[Which judge](#which-judge).
`cut` is `hunks` (one diff hunk per piece, no parser, the default), `functions` (tree-sitter,
one whole function per piece) or `chunks` (a file's hunks grouped into pieces of up to 12,000
bytes, no parser). A key stop-rules does not know, a value of the wrong type or a value out of
range stops the run with one line naming the key.

[docs/TUNING.md](docs/TUNING.md) goes through each knob: what it does, what happens when you
turn it each way, real examples with the scores the live service gave them, what each setting
caught and flagged on 240 real agent written changes, and what the tokens cost in money at
TypeSafe's published price.

Environment: `TYPESAFE_API_KEY` or `TYPESAFE_API_KEY_FILE` for your own Jev key,
`OPENAI_API_KEY` or `OPENAI_API_KEY_FILE` for your own OpenAI key,
`STOP_RULES_ENDPOINT` and `STOP_RULES_TOKEN` for team mode,
`STOP_RULES_JEV_ENDPOINT` and `STOP_RULES_JEV_MODEL` to point somewhere else. A variable
that is set but empty is an error, not a shrug.

## Limits, honestly

- You need a Jev API key from TypeSafe, or an OpenAI key for the OpenAI judge.
- The OpenAI judge's answers can move between runs on a borderline piece. In the scores form,
  measured on an earlier version of the demo, asked eight times,
  cache cleared each time, about the fixed file in the demo, whose only doubtful line is a
  placeholder `https://api.example.com` URL, gpt-6-luna at effort low scored the stubs rule 0.95
  four times and 0.05 or less four times. At effort medium it scored it 0.88 to 0.95 six times
  in six. Jev scored it 0.18.
- Each piece is judged on its own, with 25 lines of the same file around it and nothing from
  any other file, so rules about cross-file architecture or consistency across a codebase are
  weak.
- Those 25 lines are read out of the new file whether or not the same change wrote them, so a
  line the change added just outside the piece is shown to Jev as if it had always been there.
  It is the code as it now stands, which is what the rule is about, but it is not a record of
  what changed. In `functions` mode the window of a piece that is not a function stops at the
  first line another piece owns, so there it never happens.
- A piece that is bigger than 60,000 bytes on its own goes to Jev without those lines. The run
  says which piece, in the report, in `check --json` and in `run.log`.
- A piece is one diff hunk, so the agent is handed the hunk the fault sits in and finds the
  exact line itself. A hunk can also start in the middle of a function, so what the agent is
  handed can have no head, even though Jev saw the lines around it. `"cut": "functions"` hands
  over the one function instead, and then a rule about how two functions fit together is not
  seen at all.
- In `functions` mode a file in a language with no grammar here is cut by diff hunk, and a file
  that will not parse is reported as not checked, never checked half way. The default mode
  parses nothing, so neither case exists there.
- Only Claude Code can run the check in the background. Everywhere else the hook blocks
  for about a second.
- In `claude -p` (print mode) background hooks are killed when the process exits, so use
  the blocking form there: drop `asyncRewake` from the settings entry.
- If a Claude Code user has `disableAllHooks` set in their settings, no hook runs at all
  and nothing tells you. We hit this ourselves.
- The check reads added lines. A rule about something deleted, such as a test being
  removed, is only seen if the same change also adds lines to that file.
- `npx github:haystackeditor/stop-rules` is untested until this repo is public, so we cannot
  say whether it works. There is no `build` script and no install script, so npm has nothing
  to rebuild, but the only path we have run is a clone plus `node bin/stop-rules.mjs`.

## Changelog

- **22 September 2026, a second judge.** `"judge": {"kind": "openai"}` in `.stop-rules.json`
  scores the pieces with OpenAI's `gpt-6-luna` instead of Jev, by default in the review form:
  one call per change, each finding quoting its line. Jev stays the default, and a
  repo that sets nothing sees no change: its cached answers are still valid. The team server
  has a second route, `POST /v1/responses`, and an optional `OPENAI_API_KEY`. See "Which judge"
  above.
- **22 September 2026, Pi.** `init` finds a `.pi` folder and writes
  `.pi/extensions/stop-rules.ts`, which runs the check when Pi is about to settle and, when a
  rule is broken, hands the report to the model with one more turn. Run with Pi 0.87.1 and
  `gpt-6-luna`: the report named two broken rules, the model replaced the direct `fetch` and the TODO
  stub with `httpGet` and `httpDelete`, and the second check was clean. Pi needs the folder trusted, see "Which agents
  are supported".
- **20 September 2026, the code around each piece.** Jev now sees 25 unchanged lines above and
  below every change, or the whole function in `functions` mode, and the claim sentence says so.
  Both go into the cache key, so the first run after this upgrade asks every piece once more and
  costs what a first run costs. Nothing you have to do. `score --show-context` prints what Jev
  saw. The numbers behind it are in "What Jev sees" above.

## Contributing

Everything in `bin/` is a build output that is committed on purpose, so a clone needs no
build: the bundle, the tree-sitter runtime and one wasm file per grammar. It must be
committed together with any source change:

```bash
npm install
npm run typecheck
npm run compile      # compiles, bundles, refreshes bin/, checks the tables and the AWS template
npm run verify:bin   # fails if anything in bin/ is not a fresh copy
```

The script is called `compile` and not `build` on purpose: npm rebuilds a package installed
from a repository when a `build` script exists, and the committed `bin/` must be used as it
is.

`npm run compile` also fails when `VERSION` in `src/version.ts` or `SERVER_VERSION` in
`src/server/handler.ts` has drifted from the version in `package.json`, when a node type
named in `src/languages.ts` is not in that grammar, or when the language table above is not
the one in the code. Run `npm run build:aws` after changing the server, so the committed
CloudFormation template keeps matching the code.

There are no tests on purpose. Changes are verified by running the thing, and the
measurements that decided every default are under [docs/measurements/](docs/measurements/).

## License

MIT
