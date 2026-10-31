# Alert surface corpus

Each file records two accessibility trees of one screen from a real simulator, and what the alert
rules in `AlertSurface` must find on that screen. `AlertSurfaceTests` replays every file on the host
with `swift test --package-path apple/snapshot-presentation`, so a rule change that loses a real
prompt fails without a device.

## Add a fixture

1. Put the screen in the state you want, using an agent-device session: open the app, `fold`, and
   raise the prompt. For prompt recipes, see `examples/test-app/README.md`.
2. Capture the app that hosts the prompt (`com.apple.springboard` for a system alert):
   `pnpm capture:alert-surface --udid <udid> --bundle <bundle id> --name <device>-<pose>-<app>-<prompt>`.
   The capture builds its runner with its own bundle id, so it runs beside the session's runner.
3. Add `expect` from the screenshot. For each source that must find the prompt, give its title and
   buttons. A source you leave out must find nothing, and `{}` marks a screen with no prompt.
4. Add `expectModalScope`, which `ModalSurfaceTests` replays through `ModalSurface`. For a screen
   whose honor-modal tree removes nothing, write `{"reading": "noExclusion"}`. Otherwise write
   `"reading": "modal"` and give each surface's `host` and `roots` as `honorModal` indexes, with the
   labels of the `actions` it offers. Then give the `excludedActions`: the labels of the
   `honorModal` actions that no surface offers.

Don't edit the trees by hand. Capture again instead. The script keeps the existing `expect` and
`expectModalScope`, but a new capture can move the indexes in `expectModalScope`.

## Format

`format` is 2. `capture` names the host bundle, device, runtime, toolchain, and commit. It also
gives the read `order` and the `milliseconds` each read took.

- `honorModal` is the tree with `snapshotKeyHonorModalViews`: the tree VoiceOver reads, without the
  content a modal view hides. On every recording here, it matched what `XCUIApplication.snapshot()`
  returned for the same screen.
- `plain` is the whole tree.
- `confirmingHonorModal` is read last. The capture fails unless it equals `honorModal`, so only its
  timing is recorded.

Each node has its preorder `index`, its `parentIndex`, and its AX identity `element`
(`pid:elementOrHash.elementID`). The same element can appear under two parents in one tree.
`viewClass` and `viewControllerClass` are present only when the AX server reports them.

## Modal surfaces

`ModalSurface` reads the pair, not one tree. Its surface is the children that `honorModal` keeps
under a node where it removes others. When a kept child holds a surface of its own, that inner
surface replaces the outer one. A keyboard's controls offer no actions, but the app's buttons
under the input assistant do. No recording here shows a keyboard. On these recordings:

- A SpringBoard alert removes content at three levels. The innermost surface is the alert.
- A page sheet keeps one container that holds the sheet and its dimming view, `dismiss popup`.
- A Safari prompt removes only the page's scroll view, so Safari's toolbar buttons are excluded.
- A screen without a modal removes nothing, which reads as `noExclusion`. That reading does not
  prove that no modal is shown.

## What it covers

The corpus tests the rules that read `XCUIApplication.snapshot()` trees, so `expect` replays on
`honorModal`: what counts as each kind of prompt, which window hosts it, and the presentation the
runner compares after a tap. Every recorded prompt also hides content from `honorModal`, and a
screen without a prompt hides nothing.

The SpringBoard probe and button taps read `XCUIElement.frame` instead. On a foldable, those frames
use the interface orientation, while snapshot frames use the panel's native orientation, so this
corpus does not cover them.

A title is the prompt node's own label. Safari's `SFDialogView` has none, so its title is empty here.
`alert get` reads the message text instead.
