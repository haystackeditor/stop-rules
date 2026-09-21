<!-- Ported from the private measurement harness on 2026-09-21. The harness holds the six
projects, every agent session, the blind answer keys and the reviewer rulings; it is not
published because its corpus includes other people's code. Every number here is from it. -->

# Iteration 1: what the four levers did

Plan: the harness's frozen plan, frozen before any call. Data: the same 96 saved agent changes
as `docs/measurements/six-projects.md`, no new agent sessions. Reports:
the measurement harness's report (one piece per call, original wording) and
the measurement harness's report (one piece per call, v2 wording).
About 2,600 Jev calls in all, about ten cents. Every flag at bar 0.4 and above has now been
ruled by a reader, so nothing below is "not ruled".

All counts are (run, rule, file) units at bar 0.5 unless a bar is named. "Real breaks" is the
blind answer key plus every flag a reviewer later ruled real, so the total moves a little from
arm to arm: an arm that finds a real break nobody had recorded gets it added to its own total.

## The short version

| what changed | real breaks caught | false alarms | arguable |
|---|---|---|---|
| the tool as shipped (four pieces per call) | 43 of 59 | 18 | 10 |
| one piece per call, same rules | 48 of 59 | 35 | 16 |
| one piece per call, 14 of 48 rules reworded | 56 of 62 | 26 | 8 |
| one piece per call, 30 of 48 rules reworded (v3) | 59 of 62 | 13 | 4 |
| **held-out: fresh Haiku sessions, v3 rules in the hook** | **27 of 34 (79%)** | **10** | **5** |
| for comparison, the original Haiku sessions, original rules, the hook | 34 of 58 (59%) | 10 | 5 |

Rewording the rules is the lever that worked. Unpacking the calls is not free. Lowering the
bar is out. A bar per kind of rule buys little once the rules are worded well.

## Lever 2, rule wording: worked

Same 96 changes, same bar, same cut, same one-piece-per-call arm. The only difference is the
text of 14 rules (the harness's project sets), changed in three ways: say what the
rule means for tests, name the folder a layer rule is about, turn a soft clause into a concrete
ban.

| | original wording | v2 wording |
|---|---|---|
| caught | 48 of 59 | 56 of 62 |
| missed | 9 | 5 |
| false alarms | 35 | 26 |
| arguable | 16 | 8 |

What moved, unit by unit (a per-unit diff of the two answer files; the list is reproducible from the
two answer files under the harness's run folders):

- 27 flags went away. 12 of them had already been ruled wrong or arguable (test files the rule
  never mentioned, a model flagged under a controller rule, a README). The other 15 were ruled
  since: 14 not a break, 1 arguable.
- 15 flags appeared. 8 are real breaks: the 3 missed money and clock breaks the old wording
  could not see, 2 more of the same kind nobody had recorded (a plain `+` on cents in a
  service; `datetime.now` in a handler), and 3 under rules that were not reworded, moved by
  the neighbouring questions in the same call. 6 were ruled not a break, 1 arguable.
- Value-format rules went from 0 of 3 caught to 3 of 3. Layer rules kept 7 of 7 and their
  false alarms went from 8 to 3. "Never call X" rules kept 32 of 36 and went from 13 false
  alarms to 8.

Per project, caught / false alarms / arguable:

| project | original | v2 |
|---|---|---|
| rails-style | 7 of 10, 1, 1 | 11 of 12, 1, 0 |
| py-service | 5 of 6, 11, 2 | 7 of 7, 7, 0 |
| go-legacy | 14 of 17, 4, 2 | 14 of 17, 2, 0 |
| rust-cli | 2 of 3, 9, 3 | 2 of 3, 9, 1 |
| react-front | 6 of 8, 2, 3 | 8 of 8, 3, 3 |
| bare-start | 14 of 15, 8, 5 | 14 of 15, 4, 4 |

Rust did not move because its 9 false alarms are all under rule 2 ("every error carries a
sentence of context"), which was not reworded; a reviewer ruled 8 of them not a break and 1
real. That rule is the next wording to fix, and it is the same shape as the money rule: the
break is "you did not use the helper", which Jev only sees when the rule names the helper and
bans the alternative.

## Lever 1, one piece per call: not free

| | four pieces per call (the hook) | one piece per call | one piece, bar 0.6 |
|---|---|---|---|
| caught | 43 of 59 | 48 of 59 | 44 of 57 |
| false alarms | 18 | 35 | 15 |
| arguable | 10 | 16 | 9 |

Packing four pieces into a call pulls every score down a little, catches and false alarms
alike. Unpacking gets 5 more catches and 17 more false alarms, at four times the calls. One
piece per call at bar 0.6 lands about where the packed hook at 0.5 already is. So packing acts
like a slightly higher bar, and there is no reason to change the tool's default.

The report's earlier arm carried the needs-more questions in the same call; with them, 49 of
59 and 41 false alarms. The probe questions add nothing.

## Lever 4, the flags between 0.4 and 0.5: bar 0.4 is out

93 units were flagged at 0.4 that nobody had judged. Reviewers ruled them: 1 real, 13
arguable, 79 not a break. Lowering the bar to 0.4 would buy one catch for about eighty wrong
flags. The default stays at 0.5 or goes up, never down.

## Lever 3, a bar per kind of rule: small once the wording is right

With the v2 wording, one piece per call, pooled over the six projects (caught of n, false
alarms):

| kind | 0.5 | 0.6 | 0.7 |
|---|---|---|---|
| never call X (36) | 32, 8 | 30, 3 | 22, 1 |
| layer (7) | 7, 3 | 7, 1 | 7, 0 |
| present (7) | 7, 4 | 6, 3 | 6, 2 |
| value format (3) | 3, 5 | 3, 0 | 3, 0 |

Layer and value-format rules would be happier at 0.6 (same catches, 7 fewer false alarms
between them); "never call X" loses 2 catches there. A per-kind bar would gain about 7 false
alarms across 96 sessions. Not nothing, but it needs a way to sort rules into kinds, which Jev
cannot do (the measurement harness) and a user would have to do by hand. Not built. Written
down for the owner.

The plain bar knob, v2 wording, all kinds together: 0.5 gives 56 of 62 with 26 false alarms;
0.6 gives 50 of 60 with 11; 0.7 gives 42 of 57 with 3. That is the trade the `threshold`
setting makes, and it is in the tool's docs.

## Round 2: a second pass at the wording (v3)

After the round above, the flags and misses that were left under v2 were listed with their
reviewer reasons, and 16 more rules were reworded (`rules-v3.md`, all six projects). Same
three kinds of edit, plus a fourth: when Jev keeps flagging code that follows the rule, name
that code as following it ("`unwrap_or` supplies a value and never panics"; "a `pub fn` with a
`///` line directly above it follows this rule"; "a schema list named QUERY is not SQL").

| | original | v2 | v3 |
|---|---|---|---|
| caught | 48 of 59 | 56 of 62 | 59 of 62 |
| missed | 9 | 5 | 3 |
| false alarms | 35 | 26 | 13 |
| arguable | 16 | 8 | 4 |

Per kind, v3 at bar 0.5 (caught of n, false alarms): never call X 34 of 36, 7; layer 7 of 7,
0; value format 5 of 5, 1; needs another file 5 of 5, 1; present 6 of 7, 2; judgment 2 of 2,
2. The bar, v3: 0.5 gives 59 of 62 with 13 false alarms; 0.6 gives 56 of 62 with 5; 0.7 gives
46 of 58 with 2.

The three misses left: a Go error that drops its cause with a message but no `%w` (0.40), a
React component building "just now" in English outside the catalogue (0.49), and a top-level
`catch` that discards the error and exits (0.47). All three sit just under the bar. The 13
false alarms left are mostly Rust rule 2, "every error carries a sentence of context": Jev
flags a `?` that forwards an error which already carries context further down. That is a
fact about another function, which a piece cannot show.

**The caveat that matters.** v2 and v3 were written after reading the false alarms on these
same 96 changes, so their numbers here are the best case. The honest test is fresh agent
output judged against the same wording. That is the held-out run below.

## Round 3: the held-out test

Six copies of the projects with `rules.md` replaced by the v3 wording
(the harness's project sets), one fresh Haiku session per task, the hook live
with the v3 rules, then the same blind reading and rulings as before. Nothing about the
wording was changed after these sessions started. Two sessions stopped at a permission
question with no change and were run again (`runs-excluded/`). 48 sessions, about 40
minutes of agent time, 200 Jev calls, 4 cents.

The comparison is the hook's own output at its own bar, Haiku sessions only, so both sides
are the same model, the same tasks, the same projects, and the same tool. The only
difference is the wording of the rules the hook holds.

| Haiku, 48 sessions each | original wording | v3 wording, fresh sessions |
|---|---|---|
| real breaks the agents made unprompted | 58 | 34 |
| caught, right file | 34 (59%) | 27 (79%) |
| caught, right rule, wrong file | 3 | 0 |
| missed | 21 | 7 |
| false alarms | 10 | 10 |
| arguable | 5 | 5 |

So on changes the wording had never seen, it caught four in five real breaks instead of
three in five, with the same number of false alarms. Fewer breaks happened this time (34
against 58, most of the drop in the Go project: 5 against 10), which is the sessions being
different, not the wording; the agent never sees the rules.

Per project, caught of real breaks / false alarms:

| project | original Haiku half | held-out v3 |
|---|---|---|
| rails-style | 5 of 10 / 2 | 6 of 7 / 4 |
| py-service | 4 of 6 / 2 | 4 of 4 / 0 |
| go-legacy | 9 of 17 / 3 | 5 of 5 / 2 |
| rust-cli | 1 of 2 / 1 | 2 of 3 / 0 |
| react-front | 6 of 8 / 0 | 5 of 6 / 1 |
| bare-start | 9 of 15 / 2 | 5 of 9 / 3 |

By kind: value-format rules went from 0 of 3 to 4 of 4. Layer rules went from 5 of 7 with 6
false alarms to 3 of 3 with 1. "Never call X" rules went from 20 of 34 to 10 of 13 with the
same 3 false alarms.

The one project that did not improve is the bare TypeScript seed, whose rules 1 to 6 are the
tool's own starter rules and were not reworded. Its 5 arguable flags are all on test files
the starter rules say nothing about, the same shape of problem the rewording fixed
everywhere else. That is the case for rewording the starter rules too.

What the agents did with the feedback, 48 sessions each: held-out, the hook reported
something in 27, the agent fixed the code in 21, argued in 5, changed nothing in 1; a
re-check of the final tree was clean in 32 of 48. Original Haiku half: reported in 30, fixed
19, argued 9, changed nothing 2; final tree clean in 25 of 48.


## Round 4: the tool's own six starter rules

The owner: "Fix the starting rules." The six starter rules were reworded the same way
(the harness's project sets, rules 1 to 6; 7 and 8 as in v3): each
says what the break looks like, what follows the rule, and what it means for tests. Scored
one piece per call on the 16 original bare-start sessions and the 8 held-out ones, new flags
ruled.

| bare TypeScript seed | previous wording | starter rules reworded |
|---|---|---|
| 16 original sessions: caught / false / arguable | 14 of 15 / 1 / 2 | 15 of 15 / 1 / 1 |
| 8 fresh sessions: caught / false / arguable | 7 of 9 / 3 / 4 | 8 of 9 / 4 / 3 |

Small set, small gain: one more catch on each set (a top-level `catch` that exits without a
word, and a deleted test), four test-file flags gone, one new false alarm (a `catch` that
logs and then exits, which the wording tried to allow and Jev still flagged at 0.74). The
reworded six are now the tool's starter rules (`src/rules.ts`) and the README example.

## What goes into the tool

- The rule-writing guide gets the three edits as instructions with the measured effect, and
  a worked example (the money rule, 0 of 3 to 3 of 3).
- The bar section gets the v2 bar table above.
- The packing default stays. The bar default moved to 0.6 on 2026-09-21, the owner's call
  on the table above; it stays a setting, and the docs now carry the three-row trade and the
  advice to run `score` on your own changes before settling on one.
- The tool's six starter rules were not reworded here. The reviewer rulings on them (bare-start
  rules 1 to 6) are: 7 not a break, 5 arguable, 0 real, at bars 0.4 to 0.5. Two of the arguable
  ones are "a fallback string that hides why it failed" and "a comment that gives a reason but
  also restates the code", both judgment calls the rule text cannot settle.
