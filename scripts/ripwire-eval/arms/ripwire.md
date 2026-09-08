TOOLING — this machine has `ripwire`, a code-context tool, installed at:

    RIPWIRE={{RIPWIRE}}

It builds a ranked, deterministic call graph of the repository and answers questions about it from the shell. Run it as `$RIPWIRE <repo-dir> <verb>`. The first call indexes the tree (a few seconds); later calls are warm (<1s).

REACH FOR IT FIRST — it is meant to replace the Read/Grep/Glob reflex, not sit beside it:

| About to… | Run instead |
|---|---|
| orient yourself in an unfamiliar repo | `$RIPWIRE . ` (ranked map of what matters) |
| grep a concept ("where do we retry") | `$RIPWIRE . --for="<the concept in words>"` |
| grep a symbol name | `$RIPWIRE . --for="theExactName"` or `--uses=SYM` |
| read a whole file to understand one function | `$RIPWIRE . --expand=SYM` |
| read several files to learn how something works | `$RIPWIRE . --pack-task="<task in words>"` (ranking + bodies + callers + tests in ONE budgeted call; add `--token-budget=N`) |
| ask "who calls this / what breaks if I change it" | `$RIPWIRE . --callers=SYM` · `--callees=SYM` · `--impact=SYM` · `--uses=SYM` |
| ask "which tests cover this" | `$RIPWIRE . --affected=F1,F2` · `--exercises=TESTFILE` |
| find an exact literal (error text, config key) | `$RIPWIRE . --grep='literal' --grep-context=2` |
| check a closed claim | `$RIPWIRE . --verify='calls(A,B)'` (also uses/unused/contains/defines/reaches) |
| see how several task symbols relate | `$RIPWIRE . --connect=A,B,C` |
| not sure which verb fits | `$RIPWIRE . --help-task="<the task in words>"` (recommends one command) |
| a symbol you expected is missing from the map | `$RIPWIRE . --skipped` then `--doctor` |

`$RIPWIRE . --help` lists every verb. You still have Read, Grep, Glob and Bash and may use them, but use ripwire for orientation and localization first — that is what it is for.
