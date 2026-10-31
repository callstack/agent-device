# Alert surface corpus

Each file is a whole accessibility tree recorded from a real simulator, and what the alert rules in
`AlertSurface` must find in it. `AlertSurfaceTests` replays every file on the host with
`swift test --package-path apple/snapshot-presentation`, so a rule change that loses a real prompt
fails without a device.

## Add a fixture

1. Put the screen in the state you want, using an agent-device session: open the app, `fold`, and
   raise the prompt. For prompt recipes, see `examples/test-app/README.md`.
2. Release the runner, because the capture runs its own XCTest process on the same simulator:
   `agent-device daemon stop --state-dir <dir> --clean`.
3. Capture the app that hosts the prompt (`com.apple.springboard` for a system alert):
   `pnpm capture:alert-surface --udid <udid> --bundle <bundle id> --name <device>-<pose>-<app>-<prompt>`.
4. Add `expect` from the screenshot. For each source that must find the prompt, give its title and
   buttons. A source you leave out must find nothing, and `{}` marks a screen with no prompt.
5. Add `nearMisses`: the list the near-miss rule reports for the tree, usually `[]`. Start it at
   `[]`; the replay fails and prints what the rule found, which you check against the screenshot
   before recording it. When one source is what catches this screen's prompt, add
   `nearMissesOmitting` with that source's name mapped to what the rule reports when its rule is
   dropped, so a rule that stops matching shows up as a named near miss instead of a silent loss.
   A fixture without `nearMisses` fails the replay, so a screen nobody checked cannot pass by
   silence.

Don't edit `nodes` by hand. Capture again instead; the script keeps the existing `expect`.

## What it covers

The corpus tests the rules that read `XCUIApplication.snapshot()` trees: what counts as each kind of
prompt, which window hosts it, and the presentation the runner compares after a tap. The
SpringBoard probe and button taps read `XCUIElement.frame` instead. On a foldable, those frames use
the interface orientation, while snapshot frames use the panel's native orientation, so this corpus
does not cover them.

A title is the prompt node's own label. Safari's `SFDialogView` has none, so its title is empty here.
`alert get` reads the message text instead.

A screen with no prompt holds `nearMisses` at `[]`, which pins the near-miss rule against ordinary
content as well as against prompts.
`iphone-duo-unfolded-safari-navigation-menu` is a loaded web page whose navigation items each wrap a
link, so their copy is the link's own words and none of them is a dialog.
