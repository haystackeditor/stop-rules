# AGENT-SETUP.md: install stop-rules for the human you are working for

You are a coding agent. This file tells you how to install `stop-rules` in the human's
repository, end to end, and how to prove it works before you say you are done.

`stop-rules` runs after a coding agent finishes a turn. It cuts the code that changed into
pieces, normally one function each, asks Jev whether any piece breaks one of the team's rules,
and hands the function that broke it back to the agent so the agent fixes it.

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
- **The first draft of the rules.** You write it from the team's own documents. Step 5.

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
- `mode`: `team` or `local`. It decides which secret the human stores in step 6.
- `grammars`: which languages this repo has, which grammar files were copied into
  `.stop-rules/`, and how big that folder now is. A language with no grammar here is cut by
  diff hunk instead, which still works.
- `agents[]`: one entry per agent, with `files` (what was written), `changed`, `ok`,
  `notes`, and `effect` in plain words. `feedback` is `continues-agent` when that agent can
  be told to fix violations, or `shown-to-user-only` when it can only show them.
- `todo[]`: what is left for the human.

If `init` says no coding agent was detected, ask the human which agent they use and run it
again with `--agents <name>`. Running `init` twice is safe: it only refreshes the copied
file and leaves every config entry alone.

## 5. Write the rules from the team's own documents

`init` wrote a starter `.stop-rules.md`. Replace its bullets with the team's real rules,
which you take from what they have already written: `CLAUDE.md`, `AGENTS.md`,
`.cursor/rules`, `CONTRIBUTING.md`, style guides, review checklists, linter configs.

Rules for writing rules:

- One checkable sentence per bullet, and say what to do instead.
- If a linter can check it, use the linter, not a rule in this file.
- A rule must be something a reviewer could judge from one piece of a change, without
  seeing the rest of the codebase.
- Skip anything a linter or formatter in this repo already enforces.
- 5 to 15 rules. More than that costs more per turn and adds noise.
- Every top-level list item is one rule. Headings and paragraphs are ignored, so you can
  keep the document's structure.

Show the list to the human and get their approval before you commit it.

## 6. Store the secret without letting it leak

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

## 7. Only if the team server is not deployed yet

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

## 8. Prove it works before you say done

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

Step 1 prints `jev: pass`. Step 3 prints one entry for the function at fault, with the rules
it breaks and its diff, and exits 2. Step 5 prints "no rule violations" and exits 0.

Match the throwaway file to a rule the team actually has, and to the language of the repo.
The example above breaks "do not silently swallow errors".

If the agent is Claude Code, tell the human this: if `disableAllHooks` is set in their
Claude Code settings, no hook runs at all and nothing warns them.

## 9. Commit, and never commit

Commit:

- `.stop-rules.md`, the rules.
- `.stop-rules/`, the checker, the parser and the grammars, so teammates and cloud agents get
  the check with nothing to install. It is a few megabytes of wasm. If the team would rather
  not keep binaries in their history, commit only `.stop-rules/stop-rules.mjs` and tell them
  that each person runs `init` again once on their own machine; until they do, files in that
  language are reported as not checked and nothing else breaks.
- The agent config files `init` wrote or changed, listed in `agents[].files`.
- `.stop-rules.json` in team mode. It holds the endpoint and no secret.

Never commit, and never print:

- The Jev API key.
- The team token.
- Anything from `~/.config/stop-rules/`.

## 10. What to tell the human at the end

- Which agents will be told to fix violations themselves, and which can only show them.
  Take this from `agents[].effect` in the JSON, word for word.
- That a clean turn is silent and costs nothing on a second run.
- In team mode: how a teammate joins. They pull, then run the one `login --token-stdin`
  line with the token from the password manager.
- In local mode: every teammate needs their own Jev key, or the team should move to team
  mode.
- That they can run `node .stop-rules/stop-rules.mjs check` by hand any time, and in CI.

## 11. Troubleshooting: what the real messages mean

| Message | What to do |
|---|---|
| `no Jev API key and no team endpoint. Set TYPESAFE_API_KEY, or store a key with stop-rules login --jev-key-stdin, or point this repo at your team server with stop-rules team <url>` | Nothing is configured yet. Do step 6. |
| `the Jev account is out of credits. Add credits at TypeSafe, then run again.` | The account behind the key has no credits. The check did not run and the same change is checked again next time. The human adds credits at TypeSafe. |
| `Jev rejected the API key.` | The key is wrong or revoked. Store the right one. |
| `the team token is missing or wrong; run stop-rules login` | The server said 401. Get the current token from the human and store it again. |
| `no team token for <url>. Store one with: printf %s "$TOKEN" \| stop-rules login --token-stdin` | Team mode is configured but this machine has no token. |
| `<repo>/.stop-rules.json has no endpoint. Write one with stop-rules team <url>, or delete the file to use your own Jev key.` | The team config file is half written. Fix it either way. |
| `TYPESAFE_API_KEY is set but empty. Unset it or put your key in it.` | An empty variable beats a stored key, so it has to be one or the other. Same for any other variable set to nothing. |
| `no rules file at <path>. Run "stop-rules init" to create one.` | `.stop-rules.md` is missing. Run `init` in that repo. |
| `no rules found in <path>. Each top-level list item is one rule.` | The rules file has no top-level bullets. Rules are `- ` items at column 0. |
| `<dir> is not inside a git repository.` | `--dir` pointed somewhere that is not a repo. |
| `the saved baseline is gone (git cleaned it up). Run stop-rules baseline --reset to start again from HEAD.` | Run that command. The next check starts from HEAD. |
| `<path>/state.json is not valid JSON ... Run stop-rules baseline --reset to start again.` | Same command fixes it. |
| `<path>/cache.json is not a stop-rules cache. Delete it and run again.` | Delete that one file. Answers are re-fetched. |
| `the <agent> hook input has no <field>` | The agent sent a payload without a field its own docs promise. Check you are on a current version of that agent, and report it. |
| `in <config file>, "hooks" is not an object. Nothing was changed: fix the file and run init again.` | That config file has a hand written value where a list or an object belongs. Fix the file; `init` never overwrites it. |
| `could not reach Jev for any piece of this diff.` | Network or server problem. Nothing was marked as checked, so the next run tries the same code again. |
| `still N violations after 3 rounds, leaving them for the user` | The agent has had three tries at the same findings. They are for the human now. |
| `stop-rules: no changes to check.` | Nothing changed since the last check. Not an error. |
| `Jev is busy on this machine, this change will be checked on the next run` | Eight Jev calls from other stop-rules runs on this machine were in flight for a minute. Nothing was marked as checked, so the next turn checks the same code. Nothing to fix. |
| `no grammar installed for .go, run stop-rules init again to add it` | This repo gained a language after `init` ran. Run `init` again in the repo; it copies the missing grammar and leaves everything else alone. |
| `<file> lines 10-40: could not be parsed as TypeScript` | The file does not parse, so it was not cut into pieces and not checked. Usually the file really is broken: open it. |
| `the tree-sitter runtime is missing at <path>` | The `.stop-rules/` folder is half there, most likely because only the bundle was committed. Run `init` again in the repo. |
| Nothing happens at all in Claude Code | Check `disableAllHooks` in their settings, and that `.claude/settings.json` has the Stop entry `init` wrote. |
