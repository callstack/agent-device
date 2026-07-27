# Replay-compat corpus

`.ad` scripts as **released** versions of agent-device wrote them, each paired with the verdict
today's parser owes it: `parses`, or `fails` with an error code and the migration hint substring.

`corpus.test.ts` runs in `unit-core` and asserts every verdict, so a grammar change cannot quietly
alter which historical script surface still loads. #1417.

## The freeze rule

**Never edit a script under `scripts/` to make a parser change pass.**

A corpus script is a recording that already exists in the wild; editing it deletes the evidence the
gate is here to keep. When a grammar change flips a verdict:

1. Leave the script byte-identical.
2. Update its `verdict` in `manifest.ts` in the same PR.
3. Say in the PR description which historical surface broke, and why the new refusal is the intended
   migration rather than a regression.

A verdict that changes from `parses` to `fails` is a compatibility break by definition. That is
allowed — the corpus only insists it be deliberate, reviewed, and paired with a migration hint good
enough to put in front of whoever recorded the script.

## What is in the corpus

- `scripts/integration/` and `scripts/examples/` — mined from the git history of
  `test/integration/replays` and `examples/test-app/replays`: one entry per distinct file content at
  a release tag.
- `scripts/docs/` — surfaces the released grammar wrote that those two suites never exercised
  (`${VAR}` parameterization, reserved/ordering `env` refusals, `wait stable` and landmark waits,
  `target-v1` annotations, retired `gesture rotate` velocity and `gesture swipe` durationMs).

Provenance lives in `manifest.ts`: `recordedBy` is the released tag whose grammar produced the
surface, and `source` is where it was mined from at that tag.

**Released surfaces only.** A grammar state that only ever existed between commits is not compat
surface — `git tag --contains <commit>` decides, and unreleased shapes stay out (AGENTS.md,
"Unreleased API surface dies free"). The corpus is baselined against tags up to v0.20.0.

## Adding an entry

1. Find the surface at a release tag (`git show <tag>:<path>`, or the released grammar/docs that
   emitted it) and copy it verbatim into `scripts/<area>/<name>.<tag>.ad`.
2. Add a `manifest.ts` entry with `recordedBy`, `source`, `covers`, and the observed verdict.
3. Run `pnpm exec vitest run --project unit-core test/replay-compat`.

Add an entry when a change retires, renames, or narrows a `.ad` form — the corpus is the record of
what that costs someone with a saved recording.
