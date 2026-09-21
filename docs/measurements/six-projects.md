<!-- Ported from the private measurement harness on 2026-09-21. The harness holds the six
projects, every agent session, the blind answer keys and the reviewer rulings; it is not
published because its corpus includes other people's code. Every number here is from it. -->

# Six projects, 96 agent sessions: where the stop hook helps

Written 2026-09-21 from the measurement harness's report, which the harness
wrote from the data in the harness's project sets. Every number below is in that report with
its n. Tool at commit `1dbf768`, bar 0.5, cut by hunk, four pieces per call.

## What was done

Six small projects were written for this, one per language and shape. Each got 8 rules the
agent never saw and 8 tasks (4 that extend existing code, 4 that add a new subsystem). Each
task was run once with Sonnet and once with Haiku, in a real Claude Code session with the
hook live, so 16 sessions per project and 96 in all.

| project | language | what the base code does about the rules |
|---|---|---|
| rails-style | Ruby | follows all 8 |
| py-service | Python | follows 6, says nothing about 2 |
| go-legacy | Go | follows 4, the old half of the code breaks the other 4 |
| rust-cli | Rust | follows 7, says nothing about 1 |
| react-front | TypeScript, React | follows all 8 |
| bare-start | TypeScript | a near-empty seed: the 6 starter rules plus 2 house rules, nothing to copy from |

A blind reader who saw only the change and the rules wrote the answer key for every session,
before any score was looked at. A flag in a file the reader did not name went to a second
reviewer, who ruled it real, arguable or not a break. Nothing is counted as a false alarm
without that ruling. One bare-start Sonnet session stopped at a permission question with no
change and was run again; the empty one is kept under `runs-excluded/`.

## The headline

The tool's own output at its own bar, all six projects:

| | count |
|---|---|
| real breaks the agents made unprompted | 59 |
| caught, in the right file | 43 |
| caught, right rule, wrong file | 5 |
| missed | 11 |
| false alarms (ruled not a break) | 18 |
| arguable (rule wording decides) | 10 |

So about three in four real breaks were pointed at, and for every two real catches there was
about one flag that was wrong or arguable. All 96 sessions together cost $0.07 in Jev calls
(374 calls), under a tenth of a cent per session.

Haiku broke a rule in 30 of its 48 sessions (39 breaks). Sonnet broke one in 11 of 48 (13
breaks). The tool matters more for the weaker model.

## Where it helps, per project

| project | real breaks | caught | wrong file | missed | false alarms | arguable |
|---|---|---|---|---|---|---|
| go-legacy | 17 | 13 | 3 | 1 | 5 | 2 |
| bare-start | 15 | 11 | 0 | 4 | 3 | 2 |
| rails-style | 11 | 7 | 1 | 3 | 2 | 1 |
| react-front | 8 | 6 | 0 | 2 | 3 | 1 |
| py-service | 6 | 5 | 0 | 1 | 4 | 2 |
| rust-cli | 2 | 1 | 1 | 0 | 1 | 2 |

Two shapes of project produced most of the breaks and most of the catches:

- **Old code that already breaks the rules** (go-legacy). The agent copies what it sees. In
  the four rules the old code contradicts, the agents broke them 10 times and the tool caught
  9, with no false alarms. In the four rules the code follows, 7 breaks, 4 caught, 5 false
  alarms.
- **Nothing to copy from** (bare-start, and every "new subsystem" task). With no example
  nearby, the agents broke the starter rules 15 times in 16 sessions, and the tool caught 11.

Where the code already follows the rules and the task extends it, the agents mostly followed
the rules by imitation (rust-cli: 2 breaks in 16 sessions; react-front Sonnet: 0 in 8), and
the tool has little to catch. Its flags there are mostly the noise described below.

By task kind, all projects: extend tasks had 20 real breaks, 15 caught, 5 false alarms; new
subsystem tasks had 39 real breaks, 28 caught, 5 in the wrong file, 13 false alarms and 8
arguable.

## Where it helps, per kind of rule

| kind of rule | rules | real breaks | caught | wrong file | missed | false alarms | arguable |
|---|---|---|---|---|---|---|---|
| never call X, use Y | 24 | 35 | 27 | 3 | 5 | 5 | 3 |
| layer or folder | 8 | 7 | 7 | 0 | 0 | 9 | 2 |
| something must be present | 6 | 7 | 6 | 0 | 1 | 2 | 1 |
| needs another file | 6 | 5 | 3 | 2 | 0 | 0 | 3 |
| a value's format | 3 | 3 | 0 | 0 | 3 | 0 | 0 |
| judgment | 4 | 2 | 0 | 0 | 2 | 2 | 1 |

- **Never call X** is the workhorse: most of the rules, most of the breaks, most of the
  catches, and a false alarm rate of about one in seven flags.
- **Layer rules** caught every break but produced more false alarms than catches. Every one of
  those false alarms was a flag on a file outside the layer the rule restricts: a model, the
  composition root, a service reading values a handler had already checked, a README.
- **Value format rules** ("timestamps are ISO 8601 in UTC") caught 0 of 3. Three is too few to
  conclude much, but there is no evidence they work.
- **Judgment rules** (comments that only restate the code, fallbacks that hide a failure)
  caught 0 of 2 here, with 2 false alarms. On the 240-change corpus they scored well, so this
  is small-n, not a verdict.

## Where the false alarms come from

28 flags were ruled not a break or arguable. Two causes cover most of them:

- **Tests.** 12 of the 28 are flags on a test file where the rule says nothing about tests:
  a test spinning up an in-process HTTP server, a test building a path directly, a Go test
  that cannot take a context as its first argument. Readers split on whether the rule meant
  to cover tests. A rule that says what it means for tests removes this whole group.
- **Wrong file for a layer rule.** 7 of the 28 are layer rules flagged on a file the rule does
  not restrict. A rule that names the folder it applies to ("files under `lib/controllers/`
  must not...") gives Jev the fact it needs.

The rest are one-offs: a handler name that did match the naming rule, an imports block, a
catch that kept the error on a record, a CSS glyph the translation rule could not reach.

## What the agent did with a flag

Of 96 sessions: the hook reported something in 46. The agent fixed the code in 28 of those,
argued and changed nothing in 13, and did something else in 5. A re-check of the final tree
was clean in 52 of 96 sessions. When the agent argues, the hook goes quiet (it reports each
finding once), so the argued cases are where a `check` gate is needed.

## The bar

The arm that re-scores every first-stop tree one piece per call, all six projects:

| bar | caught | false alarms | not yet ruled |
|---|---|---|---|
| 0.4 | 56 of 59 | 14 | 89 |
| 0.5 | 48 of 58 | 9 | 41 |
| 0.6 | 43 of 57 | 6 | 13 |
| 0.7 | 35 of 55 | 3 | 5 |

Raising the bar from 0.5 to 0.7 gives up 13 catches to remove 6 false alarms. The "not yet
ruled" column is large at the low bars: those flags fell in files the blind reader did not
name and nobody has judged them, so they are not counted either way.

## What changed in the tool because of this

Nothing in the code. Two lines in the rule-writing guide: say what a rule means for tests,
and name the folder a layer rule applies to. The table above went into `docs/TUNING.md` and
the README.
