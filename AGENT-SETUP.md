# AGENT-SETUP.md: install stop-rules for the human you are working for

You are a coding agent. This file tells you how to install `stop-rules` in the human's
repository, end to end, and how to prove it works before you say you are done.

`stop-rules` runs after a coding agent finishes a turn. It cuts the code that changed into
pieces, one git diff hunk each, asks Jev whether any piece breaks one of the team's rules, and
hands the piece that broke it back to the agent so the agent fixes it.

## 1. Ask the human these questions, all at once, before you do anything

1. Just you, or your whole team?
2. If team: is the team server already deployed? If yes, what is its URL? If no, which
   cloud do you already have an account on? The supported ones are Cloudflare Workers,
   Vercel, Netlify, Render, Google Cloud Run, Heroku, DigitalOcean App Platform, AWS
   Lambda, Deno Deploy, Supabase Edge Functions, Fly.io, Railway, Azure Container Apps, or
   any Docker host or plain VM.
3. Do you have a Jev API key from TypeSafe? If they do not, stop here and tell them:
   nothing works without one, and we do not provide keys.

Wait for the answers. Do not guess them.

## 2. Work these out yourself. Do not ask

- **Which coding agents this repo uses.** `init` detects them from the files in the repo.
  Pass `--agents` only if the human named agents that `init` did not find.
- **The first draft of the rules.** You write it from the team's own documents. Step 6.

## 3. Get the tool

```bash
git clone https://github.com/haystackeditor/stop-rules /tmp/stop-rules
```

That is all. There is no `npm install` and no build step: `/tmp/stop-rules/bin/stop-rules.mjs`
is a committed, ready to run file, and `bin/` also holds the parser and one grammar file per
language. Node 20 or newer.

If that clone fails because the repository is not public yet, ask the human where their copy
is and clone from there. Any path works: the file you need is `bin/stop-rules.mjs`.

## 4. Install into the repo

Local mode, one person:

```bash
node /tmp/stop-rules/bin/stop-rules.mjs init --dir /path/to/repo --json
```

Team mode, with the server's URL:

```bash
node /tmp/stop-rules/bin/stop-rules.mjs init --dir /path/to/repo --team https://their-endpoint --json
```

Read the JSON it prints. The fields you need:

- `ok`: false means nothing was installed. `errors` says why.
- `mode`: `team` or `local`. It decides which secret the human stores in step 7.
- `cut`: how this repo will cut a change into pieces. `hunks` is the default, and then nothing
  is parsed, no grammar file is copied, and `grammars.languages` is empty. That is not a
  failure. It is `functions` only when this run passed `--cut functions` or the repo's
  `.stop-rules.json` already said so.
- `grammars`, in `functions` mode only: which languages this repo has, which grammar files were
  copied into `.stop-rules/`, and how big that folder now is. A language with no grammar here is
  cut by diff hunk instead, which still works. `languages` is read from the files git tracks and
  the untracked ones it would add, so a repository with no commit yet still gets its grammars.
  When the repository has no file in a supported language at all, `todo[]` says so and asks you
  to run `init` again once there is one.
- `agents[]`: one entry per agent, with `files` (what was written), `changed`, `ok`,
  `notes`, and `effect` in plain words. `feedback` is `continues-agent` when that agent can
  be told to fix violations, or `shown-to-user-only` when it can only show them.
- `todo[]`: what is left for the human.

If `init` says no coding agent was detected, ask the human which agent they use and run it
again with `--agents <name>`. Running `init` twice is safe: it only refreshes the copied
file and leaves every config entry alone.

Install from the clone's `bin/stop-rules.mjs`, as above. Every command works on the repository
`--dir` names, or the one holding the folder you are in when you do not pass it, and the copy
`init` vendors into a repository works on that repository only: run it from elsewhere and it
stops and names both repositories instead of quietly checking the wrong one.

## 5. Show the human the knobs, and ask

There are four knobs, they all live in `.stop-rules.json` in the repository root, and you do
not pick them silently. Show the human this list, say what each default is, and ask which
ones they want to change. [docs/TUNING.md](docs/TUNING.md) has the real examples and the
measured totals behind each one, so read it before you answer questions about it.

| Knob | Default | What turning it does |
|---|---|---|
| `cut` | `hunks` | `hunks` uses no parser, is one file of 334 KB, covers every language, and hands the agent the git diff hunk the fault sits in. `functions` uses tree-sitter, hands the agent the one function at fault instead, and copies a few megabytes of grammar files into `.stop-rules/`. `chunks` installs the same one file as the default and uses bigger pieces, up to 12,000 bytes, which is the quietest of the three and hands over the most code. |
| `threshold` | `0.5` | The bar a score must reach to count. Lower catches more and flags more. Measured on 240 real changes cut the default way, with 29 real problems in them: 0.5 caught 22 with 6 plainly false flags and 5 arguable, and 0.6 caught 11 with 1 plainly false flag. |
| `maxCalls` | `60` | Requests to Jev in one run. When it runs out, the rest of the change is reported as not checked and picked up on the next run. |
| `endpoint` | none, so each person uses their own Jev key | Team mode: questions go to your team's server, which holds the one key. |

Say this about the cut, in plain words, because it is the one the human is most likely to want
changed: the default is git diff hunks, and nothing is installed for it. Tree-sitter would buy
them one thing, that the agent is handed exactly one function rather than the hunk it sits in,
and it costs a few megabytes of grammar files in the repository and works in 10 languages only
(TypeScript, TSX, JavaScript, Python, Go, Rust, Ruby, Java, Kotlin and Swift). Everything else
in that mode falls back to hunks, and a file that will not parse is not checked at all.

Then: the defaults are the defaults because they were measured, not because they are right for
this repository. If the human does not want to decide now, leave every knob alone and do not
write the file: `init` writes `.stop-rules.json` only when it has something to put in it, so a
plain install has no settings file and takes the defaults.

If they want tree-sitter:

```bash
# functions mode: copies the parser and the grammars, and writes {"cut":"functions"}
node /tmp/stop-rules/bin/stop-rules.mjs init --dir /path/to/repo --cut functions --json
```

`threshold` and `maxCalls` you put in `.stop-rules.json` by hand, next to whatever `init`
wrote. Then show them the scores on their own code, which costs a few Jev calls and no
guesswork:

```bash
node .stop-rules/stop-rules.mjs score
```

That prints every piece with every rule's score and applies no bar, so the human can see
where their own code sits before they settle on one. Jev is shown each piece with 25 unchanged
lines of the file above and below the change, or the whole function in `functions` mode, so if a
score surprises the human, run `score --show-context` and read what Jev actually saw.

## 6. Write the rules from the team's own documents

`init` wrote a starter `.stop-rules.md`. Replace its bullets with the team's real rules,
which you take from what they have already written: `CLAUDE.md`, `AGENTS.md`,
`.cursor/rules`, `CONTRIBUTING.md`, style guides, review checklists, linter configs.

Rules for writing rules:

- One checkable sentence per bullet, and say what to do instead.
- If a linter can check it, use the linter, not a rule in this file.
- A rule must be something a reviewer could judge from one piece of a change, without
  seeing the rest of the codebase.
- Prefer "never call X, use Y instead", where X is a name the code shows. That kind was
  measured working: in a 16 session experiment on 19 September 2026 a raw HTTP call in a
  codebase with its own helper scored 0.88 and the agent fixed it, and planted `fetch(`,
  `console.log` and `toFixed` scored 0.92, 0.94 and 0.87. Our own example pair scores 0.92 on
  the call the rule forbids and 0.10 on the helper it asks for.
- Do not write a rule about something that is missing, such as "every exported function has a
  doc comment". In the same experiment the one real breach scored 0.21 and permitted code
  scored up to 0.48, the wrong way round. A linter does this properly.
- Do not write a rule that needs the rest of the file or the codebase. A piece is all Jev
  sees.
- Be careful with a rule whose answer depends on which layer or folder a file is in
  ("handlers must not touch storage, services may"). In the experiment it inverted, scoring
  0.69 on the services the rule allows and 0.11 on a real breach; on our own small example it
  did not invert at all. If the team wants one, run `score` on their code first and show them
  the numbers.
- Tell them the honest headline: in a codebase that already shows its conventions, Sonnet and
  Haiku followed all 8 house rules by imitation in 14 of those 16 sessions, with 3 real breaks
  in total, 1 caught, 2 missed and 1 false alarm. The check earns its keep where the agent
  builds something new with nothing nearby to copy. [docs/TUNING.md](docs/TUNING.md) has both
  sets of numbers and the commands that produced ours.
- Skip anything a linter or formatter in this repo already enforces.
- 5 to 15 rules. More than that costs more per turn and adds noise.
- Every top-level list item is one rule. Headings and paragraphs are ignored, so you can
  keep the document's structure.

Show the list to the human and get their approval before you commit it.

## 7. Store the secret without letting it leak

In team mode, the human's team token:

```bash
printf %s "$STOP_RULES_TOKEN" | node .stop-rules/stop-rules.mjs login --token-stdin
```

In local mode, the human's own Jev key:

```bash
printf %s "$JEV_KEY" | node .stop-rules/stop-rules.mjs login --jev-key-stdin
```

Rules you must follow here:

- The secret arrives on stdin. Never put it in a command line argument, where it lands in
  the shell history and the process list.
- Never print it, never echo it back in chat, never write it into a file in the repo.
- If the human has not given you the secret, do not ask for it in chat. Give them the exact
  line to run themselves.
- If the secret is already in a file, pipe the file and never name it in an argument:
  `cat /path/to/key | node .stop-rules/stop-rules.mjs login --jev-key-stdin`. Do not write
  `printf %s "$(cat /path/to/key)"`, which puts the secret in the process list.

The file it writes is `~/.config/stop-rules/token` or `~/.config/stop-rules/jev-key`, mode
0600, outside the repo.

## 8. Only if the team server is not deployed yet

Follow [DEPLOY.md](DEPLOY.md) for the cloud the human named. The targets are listed fastest
first.

- The human clicks the deploy button, or runs the one command themselves, because it needs
  their cloud login. You do not log in to their cloud account.
- Two secrets, always the same two: `TYPESAFE_API_KEY` (their Jev key, which stays on the
  server) and `STOP_RULES_TOKEN` (the team token every developer's hook sends).
- Generate the team token with a random generator, not from your head:
  `openssl rand -hex 24`.
- Hand the token to the human and tell them to share it with the team through their
  password manager. Never commit it, never paste it into an issue or a chat.
- When the deploy is done, open `<endpoint>/health` in a browser or with curl. It answers
  `{"ok":true,...,"configured":true,"missing":[]}` when both secrets are set, and names any
  that are missing.
- Then run `init --team <endpoint>` from step 4, or `stop-rules team <endpoint>` if the repo
  is already installed.

## 9. Prove it works before you say done

Run all five steps and show the human the output of the middle three:

```bash
cd /path/to/repo

# 1. the credential and the endpoint
node .stop-rules/stop-rules.mjs login --check

# 2. a throwaway file that breaks one rule on purpose
cat > throwaway-stop-rules-check.ts <<'EOF'
export function readConfig(path: string): string {
  try {
    return require("node:fs").readFileSync(path, "utf8");
  } catch (error) {
  }
  return "";
}
EOF

# 3. the check finds it
node .stop-rules/stop-rules.mjs check

# 4. remove the throwaway file
rm throwaway-stop-rules-check.ts

# 5. the check is clean again
node .stop-rules/stop-rules.mjs check
```

Step 1 prints `jev: pass`. Step 3 prints one entry for the piece at fault, which is the diff
hunk by default and the named function in `functions` mode, with the rules it breaks and its
diff, and exits 2. Step 5 prints "no rule violations" and exits 0.

Match the throwaway file to a rule the team actually has, and to the language of the repo.
The example above breaks "do not silently swallow errors".

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

Tell the human this if anything of theirs wraps the hook. A wrapper that captures only stdout
loses the entire report for the five agents that write it to stderr, and four of the thirteen
deliver a report while exiting 0, so the exit code alone does not say whether the turn was
clean. On a clean turn every adapter exits 0 and writes nothing, except Gemini CLI and Cursor,
which write `{}`, and Cline, which writes `{"cancel":false}`.

In CI or a script, use `check`, not `hook`: `check` prints its report on stdout and exits 2
when a rule is broken.

If the agent is Claude Code, tell the human this: if `disableAllHooks` is set in their
Claude Code settings, no hook runs at all and nothing warns them.

## 10. Commit, and never commit

Commit:

- `.stop-rules.md`, the rules.
- `.stop-rules/`, so teammates and cloud agents get the check with nothing to install. On a
  default install that is one file of 334 KB. In `functions` mode it also holds the parser and
  the grammars, a few megabytes of wasm; if the team would rather not keep binaries in their
  history, commit only `.stop-rules/stop-rules.mjs` and tell them that each person runs `init`
  again once on their own machine; until they do, files in that language are reported as not
  checked and nothing else breaks.
- The agent config files `init` wrote or changed, listed in `agents[].files`.
- `.stop-rules.json`, if there is one. It holds the knobs and the team endpoint, and no secret.

Never commit, and never print:

- The Jev API key.
- The team token.
- Anything from `~/.config/stop-rules/`.

## 11. What to tell the human at the end

- Which agents will be told to fix violations themselves, and which can only show them.
  Take this from `agents[].effect` in the JSON, word for word.
- That a clean turn is silent and costs nothing on a second run.
- That the hook tells the agent once and never nags. If the agent decides the rule does not
  apply and changes nothing, the next turn is silent while the code still breaks the rule, so
  a quiet hook is not a clean codebase. In a 16 session experiment on 19 September 2026, 3
  sessions ended exactly that way: the agent argued, the code stayed, and
  `stop-rules check --base HEAD` still reported the finding.
- That `stop-rules check --base <rev>` is therefore the gate to trust, in a pre-commit hook or
  in CI. It is read only and reports the same finding every time. It also has no way to mark a
  finding as accepted, so a false alarm keeps being reported there until they reword the rule
  or change the code. There is no accept or ignore list.
- In team mode: how a teammate joins. They pull, then run the one `login --token-stdin`
  line with the token from the password manager.
- In local mode: every teammate needs their own Jev key, or the team should move to team
  mode.
- That they can run `node .stop-rules/stop-rules.mjs check` by hand any time, and in CI.

## 12. Troubleshooting: what the real messages mean

| Message | What to do |
|---|---|
| `no Jev API key and no team endpoint. Set TYPESAFE_API_KEY, or store a key with stop-rules login --jev-key-stdin, or point this repo at your team server with stop-rules team <url>` | Nothing is configured yet. Do step 7. |
| `the Jev account is out of credits. Add credits at TypeSafe, then run again.` | The account behind the key has no credits. The check did not run and the same change is checked again next time. The human adds credits at TypeSafe. |
| `Jev rejected the API key.` | The key is wrong or revoked. Store the right one. |
| `the team token is missing or wrong; run stop-rules login` | The server said 401. Get the current token from the human and store it again. |
| `no team token for <url>. Store one with: printf %s "$TOKEN" \| stop-rules login --token-stdin` | Team mode is configured but this machine has no token. |
| `<repo>/.stop-rules.json sets "x", which stop-rules does not know. The settings are endpoint, cut, threshold, maxCalls.` | A typo in the settings file. Fix that one key. The same shape of message names a wrong type, a value out of range, or a `cut` that is not functions, hunks or chunks. |
| `TYPESAFE_API_KEY is set but empty. Unset it or put your key in it.` | An empty variable beats a stored key, so it has to be one or the other. Same for any other variable set to nothing. |
| `no rules file at <path>. Run "stop-rules init" to create one.` | `.stop-rules.md` is missing. Run `init` in that repo. |
| `no rules found in <path>. Each top-level list item is one rule.` | The rules file has no top-level bullets. Rules are `- ` items at column 0. |
| `<dir> is not inside a git repository.` | `--dir` pointed somewhere that is not a repo. |
| `there is no directory at <path>.` | `--dir` pointed at a path that is not there. Check the spelling. |
| `this is the copy of stop-rules vendored in <repo A>, and it was about to work on <repo B>.` | A repository's own `.stop-rules/stop-rules.mjs` only works on that repository. Pass `--dir <repo A>`, or change into the repository you meant, or use the clone's `bin/stop-rules.mjs` to install somewhere else. |
| `no source files in a supported language yet: run stop-rules init again after you add some` | Only from `init --cut functions`: it found no file in a language it can parse, so it copied no grammar. Add the first source files, then run `init` again in that repo. |
| `the saved baseline is gone (git cleaned it up). Run stop-rules baseline --reset to start again from HEAD.` | Run that command. The next check starts from HEAD. |
| `<path>/state.json is not valid JSON ... Run stop-rules baseline --reset to start again.` | Same command fixes it. |
| `<path>/cache.json is not a stop-rules cache. Delete it and run again.` | Delete that one file. Answers are re-fetched. |
| `the <agent> hook input has no <field>` | The agent sent a payload without a field its own docs promise. Check you are on a current version of that agent, and report it. |
| `in <config file>, "hooks" is not an object. Nothing was changed: fix the file and run init again.` | That config file has a hand written value where a list or an object belongs. Fix the file; `init` never overwrites it. |
| `could not reach Jev for any piece of this diff.` | Network or server problem. Nothing was marked as checked, so the next run tries the same code again. |
| `still N violations after 3 rounds, leaving them for the user` | The agent has had three tries at the same findings. They are for the human now. |
| `stop-rules: nothing changed since the last check.` | Nothing changed since the last check. Not an error. |
| `stop-rules: 1 file changed and none of it could be checked.` | Something did change and none of it was judged, so this is not a clean result. The reasons follow on the "Not checked" lines, usually a missing grammar or a file that will not parse. In `hook` mode the same case exits 1 with that reason instead of staying quiet. |
| `stop-rules: no rule violations in the 3 pieces that were checked, and 2 not checked, listed below.` | Part of the change was judged and part was not. The part that was judged broke no rule. |
| `Jev is busy on this machine, this change will be checked on the next run` | Eight Jev calls from other stop-rules runs on this machine were in flight for a minute. Nothing was marked as checked, so the next turn checks the same code. Nothing to fix. |
| `no grammar installed for .go, run stop-rules init again to add it` | Only in `functions` mode. This repo gained a language after `init` ran, or the grammars were never copied. Run `init` again in the repo; it copies the missing grammar and leaves everything else alone. The tool never switches to hunks by itself, so this keeps being reported until the grammar is there or the setting changes. |
| `<file> lines 10-40: could not be parsed as TypeScript` | The file does not parse, so it was not cut into pieces and not checked. Usually the file really is broken: open it. |
| `the tree-sitter runtime is missing at <path>` | The `.stop-rules/` folder is half there, most likely because only the bundle was committed. Run `init` again in the repo. |
| Nothing happens at all in Claude Code | Check `disableAllHooks` in their settings, and that `.claude/settings.json` has the Stop entry `init` wrote. |
