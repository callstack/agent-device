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

Don't edit `nodes` by hand. Capture again instead; the script keeps the existing `expect`.

## What it covers

The corpus tests the rules that read `XCUIApplication.snapshot()` trees: what counts as each kind of
prompt, which window hosts it, and the presentation the runner compares after a tap. The
SpringBoard probe and button taps read `XCUIElement.frame` instead. On a foldable, those frames use
the interface orientation, while snapshot frames use the panel's native orientation, so this corpus
does not cover them.

A title is the prompt node's own label. Safari's `SFDialogView` has none, so its title is empty here.
`alert get` reads the message text instead.
