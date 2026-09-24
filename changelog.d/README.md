# changelog.d/

A PR with a user-visible change adds one fragment file here instead of editing `CHANGELOG.md`
directly. PRs never edit `CHANGELOG.md`. Only the `npm version` release commit writes it, by
running `scripts/changelog-release.ts` to fold every fragment present into a new version section
and delete the fragments it consumed.

This file is the only non-fragment file kept in this directory, so the directory stays in place
when no fragments are pending.

## Adding a fragment

Create `changelog.d/<slug>.md`, where `<slug>` matches `^[a-z0-9][a-z0-9-]*$`. By convention, base
it on the branch name: `<issue-number>-<short-kebab>`, for example
`changelog.d/2799-macos-fullscreen-surfaces.md`. The PR number is not required in the name — it is
not known before the PR opens.

A fragment holds one or more bullets. Each bullet starts on a line matching:

```
^- (Breaking|Added|Changed|Deprecated|Removed|Fixed|Security)( \([^)]+\))?: \S
```

Continuation lines are indented by two spaces. Blank lines between bullets are allowed. Anything
else fails validation, including a leading non-bullet line or an unknown kind.

Example:

```md
- Fixed (macos): `screenshot --fullscreen` on the `desktop`, `menubar`, or `frontmost-app`
  surface now refuses with `INVALID_ARGS` instead of being ignored. (#2849)
```

## Assembly

`npm version` runs the assembler as part of its `version` lifecycle script. It sorts bullets by
kind rank (Breaking, Removed, Changed, Deprecated, Added, Fixed, Security), then by fragment file
name, then by position within the fragment — deterministic regardless of the order the fragments
were added in — and writes the result under a new `## <version>` heading. `release:prepare` runs
the assembler with `--check`, which fails if any fragment is still present: that means a release
skipped assembly.
