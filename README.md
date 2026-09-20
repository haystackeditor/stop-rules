# stop-rules

`stop-rules` holds your coding agent to your team's written coding rules. When the agent
finishes a turn, it cuts the code changed since the last check into pieces, normally one
function each, and asks [Jev](https://typesafe.ai) one yes or no question per piece and per
rule. If a rule is likely broken, it hands that one function back to the agent so it fixes it
before you see it.

Using a coding agent? Point it at [AGENT-SETUP.md](AGENT-SETUP.md) and let it do the
install.

## Quick start, just you

```bash
git clone https://github.com/haystackeditor/stop-rules
node stop-rules/bin/stop-rules.mjs init --dir /path/to/your/repo
```

No `npm install`, no build: `bin/stop-rules.mjs` is committed and ready to run.

`init` finds which coding agents your repo already uses, copies itself into
`.stop-rules/stop-rules.mjs` there, copies the parser and only the grammars for the languages
your repo is written in, writes a starter `.stop-rules.md`, and wires the hook into each
agent's own config file. Then:

```bash
cd /path/to/your/repo
printf %s "$JEV_KEY" | node .stop-rules/stop-rules.mjs login --jev-key-stdin
node .stop-rules/stop-rules.mjs login --check
```

Edit `.stop-rules.md` so it says what your team cares about, then commit `.stop-rules.md`,
the `.stop-rules/` folder and the agent config files. Your key is not in any of them: it
lives in `~/.config/stop-rules/jev-key`, mode 0600.

`.stop-rules/` holds the checker, the parser and one grammar file per language, so it is a few
megabytes. Commit it and teammates and cloud agents get the check with nothing to install. If
you would rather not have binaries in git, leave the grammars out and each person runs `init`
again on their own machine; a language whose grammar is missing is reported as not checked and
nothing else breaks.

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
the team token.

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
| Aider | told to fix it, as lint output | simulated run only, matches its docs |
| Windsurf Cascade | shown to you only | simulated hook input only, matches its docs |
| Cline | shown to you only | simulated hook input only, see the note below |
| plain | prints the report, exit 2 | used by the OpenCode and Amp plugins |

Only Claude Code can run the check in the background and still reach the agent. Every other
agent runs it as a normal blocking hook, which takes about a second.

Cline is the one case where the documentation disagrees with itself. Its hooks README
documents the `TaskComplete` hook, the file it lives in and the JSON it must answer with,
and the same README marks that event "coming soon!". The file is written to the documented
contract, so if your Cline never runs it, that is why.

## Which languages it can cut into pieces

A change is judged one piece at a time, and a piece is normally one whole function. That
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

Any other file is cut by diff hunk instead, which works and is a little blunter.
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
  it, return it to the caller, or log it with enough context to debug.
- Do not leave stubs, placeholders, TODO implementations or fake data in code that is
  presented as finished.
```

Rules that work less well are the vague ones ("write clean code") and the ones about things
one piece of a change cannot show ("keep the service boundaries tidy").

### Which kinds of rule Jev can judge, measured

Two sources, kept apart. The **experiment** is 16 real coding agent sessions, Sonnet and
Haiku, on one small service with 8 team rules the agent could not see, run on 19 September
2026; its numbers are that experiment's, not a run of ours. The **example scores** are ours:
the files in [`examples/tuning/`](examples/tuning), scored against the live service on 19
September 2026, which reported its version as `jev-1.13.0`. Both samples are small.

- **Works: "never call X, use Y instead", where X is a name the code shows.** In the
  experiment a raw HTTP call in a codebase that has a helper for it scored 0.88 in a real
  session and the agent fixed it, and planted `fetch(`, `console.log` and `toFixed` scored
  0.92, 0.94 and 0.87, one of each. Our own example agrees:
  [`helper.diff`](examples/tuning/helper.diff) scores 0.92 on the function that calls `fetch`
  and 0.10 on the one that calls the helper, twice each.
- **Does not work: a rule about something that is missing** ("every exported function has a
  doc comment"). In the experiment the one real breach scored 0.21 while code the rule allows
  scored up to 0.48. A linter does this properly.
- **Does not work: a rule that needs the rest of the file or the codebase**, because a piece
  is all Jev sees.
- **Careful: a rule whose answer depends on which layer or folder the file is in** ("handlers
  must not touch storage, services may"). In the experiment it inverted: the highest scores
  landed on the services the rule allows (0.69) and a real breach scored 0.11. Our own
  example [`layers.diff`](examples/tuning/layers.diff) did the opposite, scoring 0.93 and 0.89
  on the two handlers that touch the database and 0.19 and 0.10 on the two services that do
  the same thing. So this kind depends on whether the piece itself shows which layer the file
  is in. Do not trust it without running `score` on your own code. Both sets of numbers are
  in [docs/TUNING.md](docs/TUNING.md).
- **And the honest headline.** In a codebase that already shows its own conventions, Sonnet
  and Haiku followed all 8 house rules by imitation in 14 of the 16 sessions. There were 3
  real breaks in total: 1 caught, 2 missed, and 1 false alarm. The tool earned its keep where
  the agent built something new with nothing nearby to copy from.

## How it works

1. **What changed.** The working tree is written to a git tree object through a temporary
   index, so your own index and staged changes are never touched. That snapshot is diffed
   against the tree from the last check, so each turn only pays for new work.
2. **Pieces.** Each changed file is parsed, and its diff is cut into pieces. A function,
   method, constructor or accessor is always a piece of its own, whatever its size, so a rule
   one function breaks never drags a neighbour in with it. Everything else, meaning imports,
   top level statements, constants, type declarations and plain fields, groups with the
   neighbours next to it into a piece of up to 40 added lines, and a function between them
   ends that group. A file with no grammar is cut by diff hunk instead. Lock files, minified
   bundles, data and log files, binaries and deletions are skipped. Two settings turn the
   parser off: `"cut": "hunks"` gives one diff hunk per piece, and `"cut": "chunks"` groups a
   file's hunks into pieces of up to 12,000 bytes. See [docs/TUNING.md](docs/TUNING.md) for
   what each one costs and misses.
3. **One yes or no score per rule.** Every piece is asked about every rule: does the added
   code break this rule. Jev answers each claim with a probability. At or above the cutoff
   (0.6 by default) it is a finding. Up to four pieces ride in one request, and a request is
   also bounded at 60,000 bytes, so a normal turn is one or two requests.
4. **Tell the agent.** One entry per piece: the file, the line range, the name of the
   function, then every rule that piece broke with its score, and then the piece's diff once.
   The agent gets the code that broke the rule, not a line number to go and find.

### Where the report comes out, per agent

Measured on 19 September 2026 by feeding each adapter the payload its own agent documents.
When a rule is broken:

| Agent | Where the report goes | Exit code |
|---|---|---|
| Claude Code, Codex, Gemini CLI, Factory Droid, Windsurf Cascade | stderr | 2 |
| OpenCode, Amp, plain | stdout and stderr, the same text on both | 2 |
| Aider | stdout, as lint output | 2 |
| Cursor | stdout, as JSON in `followup_message` | 0 |
| GitHub Copilot CLI, Kiro | stdout, as JSON in `reason`, next to `"decision": "block"` | 0 |
| Cline | stdout, as JSON in `contextModification` | 0 |

Read that before you wrap the hook in anything. A wrapper that captures only stdout loses
the entire report for the five agents that write it to stderr, and four of the thirteen
deliver a report while exiting 0, so an exit code alone does not tell you whether the turn
was clean. On a clean turn every adapter exits 0 and writes nothing, except Gemini CLI and
Cursor, which write `{}`, and Cline, which writes `{"cancel":false}`.

`check` is the one to use in a script: it prints its report on stdout and exits 2 when a
rule is broken.

### Quiet is not the same as clean

It never nags twice: a finding the hook has already delivered in this repo is not delivered
again. A second run over the same code costs nothing, because every answer is cached in the
repo's git directory, keyed on the model, the exact claim and the exact piece text. Packing
does not change that key, so re-packing never throws answers away. And every run has a hard
ceiling on requests (60 by default, `--max-calls`), counted across retries and splits. When
it runs out, the work left over is reported as "not checked".

That cuts both ways, and it is worth being plain about. The hook tells the agent once. If
the agent decides the rule does not apply and changes nothing, the next turn is silent while
the code still breaks the rule, so a quiet hook is not a clean codebase. In our own
experiment on 19 September 2026, 3 of 16 sessions ended that way: the agent argued and
changed nothing, the hook stayed quiet, and `check --base HEAD` still reported the finding.
`check --base <rev>` is the honest gate, because it is read only, skips nothing it has
already told an agent about, and reports the same finding every time you run it. It also has
no way to mark a finding as accepted, so a false alarm keeps coming back there until you
reword the rule or change the code.

The first line of a report is picked from the facts, so it never claims more than was done:
nothing changed since the last check, the change was checked and no rule was broken, part of
it was checked and part was not, or something changed and none of it could be checked. The
last one, for example a `.ts` file in a repo with no TypeScript grammar installed, is a could
not run in hook mode: exit 1 with the reason, not silence, because silence reads as clean.

### Why 0.6

The cutoff was measured on 240 real agent written changes, blind labelled and adjudicated.
Cutting code into whole functions does not make Jev rank better, it shifts the scores up, so
pieces need 0.6 where whole chunks needed 0.5. That is the only reason for the number. The
table of what every bar from 0.3 to 0.7 caught and flagged is in
[docs/TUNING.md](docs/TUNING.md), measured on this build.

### Not spamming Jev

Jev's rate limit is per account, so a whole team shares it and so does every tool on your
machine. Three things keep this one polite:

- One run keeps at most 4 requests in flight.
- Every stop-rules process on the machine shares 8 slots, held as lock files in your cache
  folder. If they are all busy for a minute the run stops and says so, and the same change is
  checked on the next turn.
- A 429 halves the in-flight ceiling, waits as long as `Retry-After` says, and earns one slot
  back after four answers in a row.

### How accurate is it

Small samples, measured on this build, and worth knowing before you trust it. The sample is
240 real agent written changes from 104 public repositories, labelled blind by reviewers.
There are 32 real breaks in it, across the six starter rules.

- At the default 0.6, cutting into whole functions: 10 of the 32 real breaks caught, and 19
  flags the reviewers did not agree with. Of those 19, an adjudicator had earlier called 5
  plainly not a break and 2 arguable; the other 12 nobody has ruled on.
- At 0.6, cutting into 12,000 byte chunks: 9 of 32 caught and 1 disputed flag.
- At 0.5, cutting into whole functions: 20 of 32 caught and 38 disputed flags.
- Over the 172 changes all three cut modes were scored on, at 0.5: one hunk per piece caught
  14 of 21 with 16 disputed flags, whole functions 11 of 21 with 26, and chunks 9 of 21 with
  6.
- On planted examples, measured earlier: stubs 20 of 20, hardcoded test values 12 of 20, and
  0 of 40 harmless look-alikes flagged.

Those come from one scoring run per cut mode. Asked seven times, a confident score moved by a
hundredth or two and a borderline one moved from 0.45 to 0.80, so the counts near a bar would
move a little in another run.

So it is quiet rather than thorough. It will miss things. Scores also move between Jev model
versions, so run `stop-rules score` on your own code and see. Every number above, per rule
and per bar, is in [docs/TUNING.md](docs/TUNING.md).

## What leaves your machine

Sent to Jev, per request: up to four pieces of your diff, the path of the file each one came
from, and the text of your rules. Nothing else: no repo name, no history, no file the diff
does not touch. In team mode the same request goes to your own server, which adds the Jev key
and forwards it.

Kept on your machine and never committed, in `<git dir>/stop-rules/`: `state.json` (the
baseline tree, which findings were delivered, per-session counters), `cache.json` (claim
hashes and their scores), `run.log` (one JSON line per run, capped at 1 MB) and `lock`. The
machine wide slots are small files in your cache folder (`$XDG_CACHE_HOME/stop-rules/slots`,
or `~/Library/Caches/stop-rules/slots` on a Mac), each holding a process id and a time. Your
key or token lives in `~/.config/stop-rules/` with mode 0600. Neither is ever written into
the repo, printed, or included in an error message.

## Commands

```
stop-rules init [--dir <repo>] [--agents a,b,c] [--team <url>] [--cut <mode>] [--json]
stop-rules check [--dir <repo>] [--base <rev>] [--json]
stop-rules score [--dir <repo>] [--base <rev>] [--diff <file>] [--json]
stop-rules hook [--dir <repo>] --agent <name>
stop-rules team [--dir <repo>] <url>
stop-rules login --jev-key-stdin | --token-stdin | --check [--dir <repo>]
stop-rules serve [--port n]
stop-rules baseline --reset [--dir <repo>]
```

- **init** installs into a repo. `--dir` picks the repo, `--agents` overrides detection,
  `--team` switches the repo to team mode, `--cut hunks` or `--cut chunks` installs with no
  parser files at all, `--json` prints the same facts for an agent to read.
- **check** runs the same pipeline in a terminal, for a pre-commit hook or CI. `check`
  prints its report on stdout and exits 2 when a rule is broken. Exit 0 clean, 2 findings,
  1 could not run. With `--base <rev>` it diffs that revision against your working tree;
  without it, it uses the incremental baseline but never moves it, so it is safe to repeat.
- **score** prints every piece with every rule's score and applies no cutoff, so you can see
  where your own code sits before you pick a bar. It changes nothing. `--diff <file>` scores
  a unified diff file instead of the working tree.
- **hook** is what the agents call. `--agent` says whose protocol to speak.
- **team** writes the endpoint into `.stop-rules.json`. Commit that file.
- **login** stores your Jev key or your team token, read from stdin so it never lands in
  shell history. `--check` calls your server's health route and makes one real Jev call.
- **serve** runs the team server on a laptop or a plain VM.
- **baseline --reset** forgets what was checked, so the next run starts from HEAD.

Shared flags: `--dir <path>` (the repository to work on), `--rules <path>` (default
`<repo root>/.stop-rules.md`), `--cut <mode>` (default functions), `--threshold <0..1>`
(default 0.6), `--max-calls <n>` (default 60), `--help`, `--version`.

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
  "cut": "functions",
  "threshold": 0.6,
  "maxCalls": 60
}
```

`cut` is `functions` (tree-sitter, one function per piece), `hunks` (one diff hunk per piece,
no parser) or `chunks` (a file's hunks grouped into pieces of up to 12,000 bytes, no parser).
A key stop-rules does not know, a value of the wrong type or a value out of range stops the
run with one line naming the key.

[docs/TUNING.md](docs/TUNING.md) goes through each knob: what it does, what happens when you
turn it each way, real examples with the scores the live service gave them, what each setting
caught and flagged on 240 real agent written changes, and what the tokens cost in money at
TypeSafe's published price.

Environment: `TYPESAFE_API_KEY` or `TYPESAFE_API_KEY_FILE` for your own key,
`STOP_RULES_ENDPOINT` and `STOP_RULES_TOKEN` for team mode,
`STOP_RULES_JEV_ENDPOINT` and `STOP_RULES_JEV_MODEL` to point somewhere else. A variable
that is set but empty is an error, not a shrug.

## Limits, honestly

- You need a Jev API key from TypeSafe.
- Each piece is judged on its own, so rules about cross-file architecture or consistency
  across a codebase are weak.
- A piece is one function, so a rule about how two functions fit together is not seen at all.
- A file in a language with no grammar here is cut by diff hunk, which is blunter. A file
  that will not parse is reported as not checked, never checked half way.
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

There are no tests on purpose. Changes are verified by running the thing: see the specs in
[docs/specs/](docs/specs/) for what was verified and how.

## License

MIT
