# stop-rules

`stop-rules` holds your coding agent to your team's written coding rules. When the agent
finishes a turn, it takes the code changed since the last check and asks
[Jev](https://typesafe.ai) one yes or no question per diff chunk and per rule. If a rule is
likely broken, it hands the findings back to the agent so it fixes them before you see
them.

Using a coding agent? Point it at [AGENT-SETUP.md](AGENT-SETUP.md) and let it do the
install.

## Quick start, just you

```bash
git clone https://github.com/haystackeditor/stop-rules
node stop-rules/bin/stop-rules.mjs init --dir /path/to/your/repo
```

No `npm install`, no build: `bin/stop-rules.mjs` is committed and ready to run.

`init` finds which coding agents your repo already uses, copies itself into
`.stop-rules/stop-rules.mjs` there, writes a starter `.stop-rules.md`, and wires the hook
into each agent's own config file. Then:

```bash
cd /path/to/your/repo
printf %s "$JEV_KEY" | node .stop-rules/stop-rules.mjs login --jev-key-stdin
node .stop-rules/stop-rules.mjs login --check
```

Edit `.stop-rules.md` so it says what your team cares about, then commit
`.stop-rules.md`, `.stop-rules/stop-rules.mjs` and the agent config files. Your key is not
in any of them: it lives in `~/.config/stop-rules/jev-key`, mode 0600.

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
- An error message must say what failed and include the value or identifier that caused it.
```

Rules that work less well are the vague ones ("write clean code") and the ones about things
one chunk of a diff cannot show ("keep the service boundaries tidy").

## How it works

1. **What changed.** The working tree is written to a git tree object through a temporary
   index, so your own index and staged changes are never touched. That snapshot is diffed
   against the tree from the last check, so each turn only pays for new work.
2. **Chunks.** The diff is split per file into chunks of at most 12,000 bytes. Lock files,
   minified bundles, data and log files, binaries and deletions are skipped.
3. **One yes or no score per rule.** One request per chunk asks, for every rule, whether
   the added lines break it. Jev answers each claim with a probability. At or above the
   threshold (0.5 by default) it is a finding.
4. **Find the line.** For each flagged chunk and rule, a second request asks which added
   line is at fault, one claim per line. Up to three lines are named. If no line reaches
   the threshold, the finding says so and names the block of changed lines instead. No line
   is ever guessed.
5. **Tell the agent.** The findings go to the agent as plain text: file, line, rule, the
   line itself, and the score.

It never nags twice: a finding the hook has already delivered in this repo is not delivered
again. A second run over the same code costs nothing, because every answer is cached in the
repo's git directory, keyed on the model, the exact claim and the exact chunk text. And
every run has a hard ceiling on requests (60 by default, `--max-calls`), counted across
retries and splits. When it runs out, the work left over is reported as "not checked".

## What leaves your machine

Sent to Jev, per request: one chunk of your diff, the path of the file it came from, and
the text of your rules. Nothing else: no repo name, no history, no file the diff does not
touch. In team mode the same request goes to your own server, which adds the Jev key and
forwards it.

Kept on your machine and never committed, in `<git dir>/stop-rules/`: `state.json` (the
baseline tree, which findings were delivered, per-session counters), `cache.json` (claim
hashes and their scores), `run.log` (one JSON line per run, capped at 1 MB) and `lock`.
Your key or token lives in `~/.config/stop-rules/` with mode 0600. Neither is ever written
into the repo, printed, or included in an error message.

## Commands

```
stop-rules init [--dir <repo>] [--agents a,b,c] [--team <url>] [--json]
stop-rules check [--base <rev>] [--json]
stop-rules hook --agent <name>
stop-rules team <url>
stop-rules login --jev-key-stdin | --token-stdin | --check
stop-rules serve [--port n]
stop-rules baseline --reset
```

- **init** installs into a repo. `--dir` picks the repo, `--agents` overrides detection,
  `--team` switches the repo to team mode, `--json` prints the same facts for an agent to
  read.
- **check** runs the same pipeline in a terminal, for a pre-commit hook or CI. Exit 0
  clean, 2 findings, 1 could not run. With `--base <rev>` it diffs that revision against
  your working tree; without it, it uses the incremental baseline but never moves it, so it
  is safe to repeat.
- **hook** is what the agents call. `--agent` says whose protocol to speak.
- **team** writes `.stop-rules.json` with your server's URL. Commit that file.
- **login** stores your Jev key or your team token, read from stdin so it never lands in
  shell history. `--check` calls your server's health route and makes one real Jev call.
- **serve** runs the team server on a laptop or a plain VM.
- **baseline --reset** forgets what was checked, so the next run starts from HEAD.

Shared flags: `--rules <path>` (default `<repo root>/.stop-rules.md`), `--threshold <0..1>`
(default 0.5), `--max-calls <n>` (default 60), `--help`, `--version`.

Environment: `TYPESAFE_API_KEY` or `TYPESAFE_API_KEY_FILE` for your own key,
`STOP_RULES_ENDPOINT` and `STOP_RULES_TOKEN` for team mode,
`STOP_RULES_JEV_ENDPOINT` and `STOP_RULES_JEV_MODEL` to point somewhere else. A variable
that is set but empty is an error, not a shrug.

## Limits, honestly

- You need a Jev API key from TypeSafe.
- Each chunk is judged on its own, so rules about cross-file architecture or consistency
  across a codebase are weak.
- Only Claude Code can run the check in the background. Everywhere else the hook blocks
  for about a second.
- In `claude -p` (print mode) background hooks are killed when the process exits, so use
  the blocking form there: drop `asyncRewake` from the settings entry.
- If a Claude Code user has `disableAllHooks` set in their settings, no hook runs at all
  and nothing tells you. We hit this ourselves.
- The check reads added lines. A rule about something deleted, such as a test being
  removed, is only seen if the same change also adds lines to that file.
- `npx github:haystackeditor/stop-rules` may work once the repo is public, but we cannot
  test it while it is private, and npm rebuilds a package installed from git when a `build`
  script exists, which this one has. The tested path is a clone plus
  `node bin/stop-rules.mjs`.

## Contributing

`bin/stop-rules.mjs` is a build output that is committed on purpose, so a clone needs no
build. It must be committed together with any source change:

```bash
npm install
npm run typecheck
npm run build        # compiles, bundles, refreshes bin/stop-rules.mjs, checks the AWS template
npm run verify:bin   # fails if bin/stop-rules.mjs is not a fresh build
```

`npm run build` also fails when `VERSION` in `src/version.ts` or `SERVER_VERSION` in
`src/server/handler.ts` has drifted from the version in `package.json`. Run
`npm run build:aws` after changing the server, so the committed CloudFormation template
keeps matching the code.

There are no tests on purpose. Changes are verified by running the thing: see the specs in
[docs/specs/](docs/specs/) for what was verified and how.

## License

MIT
