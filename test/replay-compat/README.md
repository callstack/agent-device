# Replay-compat corpus

`.ad` scripts as **released** versions of agent-device wrote them, each paired with the verdict
today's parser owes it: `parses`, or `fails` with an error code and the migration hint substring.

`corpus.test.ts` runs in `unit-core` and asserts every verdict through `parseReplayInput` — the same
composition `replay`/`test` use — so a grammar change cannot quietly alter which historical script
surface still loads. #1417.

## The freeze rule

**Never edit a script under `scripts/` to make a parser change pass.**

A corpus script is a recording that already exists in the wild; editing it deletes the evidence the
gate is here to keep, and the pinned identities below make an edited script fail rather than pass.
When a grammar change flips a verdict:

1. Leave the script byte-identical.
2. Update its `verdict` in `manifest.ts` in the same PR.
3. Say in the PR description which historical surface broke, and why the new refusal is the intended
   migration rather than a regression.

A verdict that changes from `parses` to `fails` is a compatibility break by definition. That is
allowed — the corpus only insists it be deliberate, reviewed, and paired with a migration hint good
enough to put in front of whoever recorded the script.

## What is in the corpus

- `scripts/integration/` and `scripts/examples/` — mined from the git history of
  `test/integration/replays` and `examples/test-app/replays`.
- `scripts/docs/` — surfaces the released grammar wrote that those two suites never exercised
  (`${VAR}` parameterization, reserved/ordering `env` refusals, `wait stable` and landmark waits,
  `target-v1` annotations, retired `gesture rotate` velocity and `gesture swipe` durationMs).

## What earns an entry

This is a **parser**-compatibility corpus, not a device matrix. An entry has to be the only witness
of something:

- a shipped syntactic form no other entry's bytes contain, or
- a distinct migration refusal (error code + hint) no other entry already provokes.

So the same flow recorded on another platform, or re-recorded at an adjacent release with only
coordinates and labels changed, does **not** get an entry: it costs maintenance and adds no parser
leverage. Each entry's `note` says which form or refusal it is the sole witness of; if a new entry
cannot claim one, it does not belong here. Keep the corpus in the tens of entries, not a mirror of
the replay-fixture tree.

## How "frozen" and "released" are enforced, not asserted

Provenance lives in `manifest.ts`. `recordedBy` is the released tag whose grammar produced the
surface, and `provenance` pins the bytes:

- `mined` entries carry the **git object id of the historical blob**. `corpus.test.ts` hashes the
  checked-in bytes and must reproduce that id, so a rewritten script cannot be made green by editing
  the manifest to match — the id is only obtainable from the released content.
- `derived` entries (`scripts/docs/`) have no historical blob to point at, so their bytes are pinned
  by SHA-256. Only the bytes are machine-checked: the `from` citation naming the released grammar or
  doc that emitted the surface is **reviewer-verified**, so a derived entry has to be reviewed against
  its cited source at that tag (`git show <tag>:<path>`) before it lands.

**Two sources, never invention.** The _form_ comes from the cited release — the script bytes are what
that tag's grammar or docs emitted. The _verdict_ comes from today's parser, because a migration
refusal for a retired form did not exist at the tag that emitted it (v0.16.8 wrote
`gesture rotate <deg> <x> <y> <velocity>`; the hint telling you to drop the velocity is current
output). So copy the form from the release and paste the code/hint from an observed run — never
paraphrase either.

The kind is not a free choice: `provenance-rules.ts` fixes it by corpus area (`scripts/integration/`
and `scripts/examples/` must stay `mined`, `scripts/docs/` is `derived`), so an edited script cannot
be relabelled `derived`, re-pinned by digest, and thereby skipped by the history check. Both the unit
test and the verifier enforce that rule, and a new area must declare its kind before entries can live
under it.

`pnpm check:replay-compat` closes the other half: it re-derives every mined id from git history
(`git rev-parse <recordedBy>:<path>`) and checks every cited tag against `git tag --list`, so an
entry cannot claim a version that was never cut. It needs full history and tags, so it runs in its
own `Replay-Compat Provenance` CI job (`fetch-depth: 0`) rather than inside the shallow-clone-safe
unit lane, and any change under `test/replay-compat/` selects it in `pnpm check:affected`.

**Released surfaces only.** A grammar state that only ever existed between commits is not compat
surface — `git tag --contains <commit>` decides, and unreleased shapes stay out (AGENTS.md,
"Unreleased API surface dies free"). The corpus is baselined against tags up to v0.20.0.

## Adding an entry

1. Find the surface at a release tag (`git show <tag>:<path>`, or the released grammar/docs that
   emitted it) and copy it verbatim into `scripts/<area>/<name>.<tag>.ad`.
2. Add a `manifest.ts` entry with `recordedBy`, `provenance`, `covers`, and a `note` naming the form
   or refusal it is the sole witness of. For a mined entry the blob id is `git rev-parse <tag>:<path>`;
   for a derived one it is `shasum -a 256 <file>`. Add the tag to `REPLAY_COMPAT_RELEASED_TAGS` if it
   is new.
3. Take the `verdict` from what the current parser does with those bytes: start from
   `verdict: { kind: 'parses' }`, run the suite, and if it refuses, paste the reported code and hint
   substring verbatim. Do not transcribe a hint from a release, an issue, or memory — the refusal is
   produced by today's parser, not by the tag that emitted the form.
4. Run `pnpm exec vitest run --project unit-core test/replay-compat` and `pnpm check:replay-compat`.

Add an entry when a change retires, renames, or narrows a `.ad` form — the corpus is the record of
what that costs someone with a saved recording.
