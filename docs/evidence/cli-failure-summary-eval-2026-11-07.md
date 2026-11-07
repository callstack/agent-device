# CLI failure summary line evaluation, 2026-11-07

In one run per cell over synthetic, author-written and author-graded renders, layout D (one summary line first and last, with the dispatch fact and a runnable Next step) recovered in 192 of 192 answers; the layout before the change recovered in 58%. Without the closing copy of the summary, recovery under `tail -1` fell to 11%. ADR 0010 decision 7 records the resulting rule.

Treat these numbers as directional. The renders are synthetic, not live CLI runs. The author wrote the Next text, the answer key and the grader, so the D result partly measures whether a model follows a correct Next step; the wrong-Next condition below measures that directly. Each cell ran once, so differences of a few points are within run noise.

## How agents trim output

Of 529 agent-device calls in recent agent transcripts that piped output through `head` or `tail`, 520 merged stderr into stdout with `2>&1`. `tail -1` was the most common cut (257), then `head -20..60` (about 100), `tail -2` (44), `tail -3` (20) and `head -1` (18). Of the `tail -1` calls, 184 were `agent-device daemon` calls in development sessions; about 90 device commands used `tail -1..3`. Many entries are repeated strings, so treat these as rough frequencies.

## Method

Twelve failure scenarios used codes, messages and hints taken from the codebase: a timed-out tap, a partial `type`, a partial `scroll`, ambiguous matches with 2 and 6 candidates, a selector without a match, no session, invalid arguments, a missing app, a busy device, a missing tool and a failed read-only snapshot. Each output was cut four ways: full, `tail -1`, `tail -3` and `head -1`. Each unique prompt went to Claude Haiku 5.5, GPT-6 Luna, GPT-6.1 Terra and Apex at low effort, in a fresh headless session from an empty directory. The grader classified the next command as recovered, investigated (read the log or rerun with `--debug`), unsafe (re-sent a possibly dispatched action), stuck or other. Each cell ran once.

| Layout | Recovered | Unsafe | Stuck | Retry judgment right | Error code seen |
| --- | ---: | ---: | ---: | ---: | ---: |
| A: before the change, footer last | 58% | 7% | 14% | 81% | 57% |
| B: footer moved behind `--debug` | 71% | 8% | 12% | 83% | 64% |
| C: summary first and last, hints unchanged | 69% | 6% | 13% | 98% | 95% |
| D: C with a runnable Next step | 100% | 0% | 0% | 97% | 96% |

Under `tail -1`, the error code was visible in 0% of A and B answers and in 100% of C and D answers. C recovered slightly less than B (69% against 71%, within run noise). A hypothesis that fits the answers: the old generic hint ("Retry with --debug") became an instruction once it was labelled Next. For the selector miss cut to one line under C, three of the four models reran the command with `--debug`.

## Isolating the repeat and blind obedience

E printed D's content with the summary once, at the top (multi-line scenarios only, 28 answers per cut):

| Cut | D, summary repeated | E, summary once |
| --- | ---: | ---: |
| full | 100% | 100% |
| `tail -3` | 100% | 75% |
| `tail -1` | 100% | 11% |

F used D's layout with a deliberately wrong Next step. Models followed it in 78 of 192 answers. They never followed a re-tap that contradicted "May have reached the device" on the same line (0/16), and they rarely followed one that contradicted an argument or session error (0/16 and 1/16). They always followed a wrong step that nothing on the line contradicted, including `agent-device close` on a busy device (16/16) and `agent-device home` after a failed read (16/16).
