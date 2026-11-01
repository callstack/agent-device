# Alert surface corpus

Each file records two accessibility trees of one screen from a real simulator, and what the alert
rules in `AlertSurface` and `ModalSurface` must find on that screen. `AlertSurfaceTests` and
`ModalSurfaceTests` replay every file on the host, so a rule change that loses a real prompt fails
without a device.

## Before you start

You need:

- Xcode with an iOS simulator runtime. The capture builds its runner with the Xcode that
  `xcode-select -p` prints.
- A booted simulator. `xcrun simctl list devices booted` prints its UDID.
- An agent-device session on that simulator that shows the screen you want to record. For the
  "Open in app" prompts, see `examples/test-app/README.md`.

## Add a recording

1. Put the screen in the state you want with the session: open the app, `fold` for a folded pose,
   and raise the prompt.
2. Record the app that hosts the prompt. For a system alert, that is `com.apple.springboard`:

   ```bash
   pnpm capture:alert-surface --udid <udid> --bundle com.apple.springboard --name iphone-duo-folded-springboard-open-in-app
   ```

   Name the recording `<device>-<pose>-<app>-<prompt>`. The capture builds a runner with its own
   bundle id, so it runs beside the session's runner. If the screen changes between its reads, the
   capture fails. Wait until the prompt stops animating, then run it again.

3. Print the honor-modal tree:

   ```bash
   pnpm print:alert-surface apple/snapshot-presentation/Tests/AlertSurfaceCorpus/iphone-duo-folded-springboard-open-in-app.json
   ```

   Each line shows a node's index, type, and label. `[kept 1 of 3 children]` marks a node where
   the honor-modal tree removed children. When `ModalSurface` reads no surface from the recording,
   the first line says why instead, for example
   `unknown: duplicatedChild at node 1 (kept 1 of 2 occurrences of row)`, and no node is marked.
   To print the whole tree, add `plain` after the path. A recording that is out of preorder stops
   the command; capture it again.

4. Add `expect` from the screenshot. For each source that must find the prompt, give its title and
   buttons. The sources are `blockingSystemModal`, `appAlert`, `safariDialog`, and `dismissPopup`.
   A source you leave out must find nothing. Write `{}` for a screen with no prompt.
5. Add `expectModalScope` from the printed tree:
   - If the first line reads `unknown: duplicatedChild`, the tree lists one element more than once
     under a node and keeps only some of them, so `ModalSurface` can't tell which occurrence lost
     children. Write `{"reading": "unknown", "reason": "duplicatedChild"}`.
   - If the first line reads `unknown` with any other reason, the replay rejects the recording.
     Capture the screen again. If the line stays, report it in an issue.
   - If no node is marked, write `{"reading": "noExclusion"}`.
   - Otherwise, write `"reading": "modal"` and one surface for each branch. The surface's `host` is
     the innermost marked node of the branch, and its `roots` are the children that node kept.
     `actions` are the labels of the controls under the roots, in the printed order. Empty labels
     count.
   - Add `excludedActions`: the labels of the honor-modal tree's controls that no surface offers.
6. Run the replay:

   ```bash
   swift test --package-path apple/snapshot-presentation
   ```

Don't edit the trees by hand. Capture again instead. A recapture keeps `expect` and
`expectModalScope`, but it can move the indexes in `expectModalScope`. After a recapture, print the
tree again and review each index. Don't copy indexes from what `ModalSurface` reads: the replay
proves nothing if the expectation comes from the rule it tests.

## Example: the SpringBoard "Open in app" alert

`iphone-duo-folded-springboard-open-in-app.json` records the alert that
`xcrun simctl openurl <udid> "agent-device-test-app://x"` raises on a folded iPhone Duo. The start
of its honor-modal tree:

```text
   0 Application ""  [kept 1 of 40 children]
   1   Window ""  [kept 1 of 3 children]
   2     Other ""  [kept 1 of 3 children]
   3       Alert "Open in “Agent Device Tester”?"
   4         Other ""
   5           Other ""
   6             Other ""
   7             Other ""
   8               ScrollView ""
   9                 Other ""
  10                   StaticText "Open in “Agent Device Tester”?"
  11                 Other ""
  12                 Other "Vertical scroll bar, 2 pages"
  13                   Other ""
  14                 Other "Horizontal scroll bar, 1 page"
  15                   Other ""
  16                 Other "Vertical scroll bar, 2 pages"
  17                   Other ""
  18                 Other "Horizontal scroll bar, 1 page"
  19                   Other ""
  20               ScrollView ""
  21                 Other ""
  22                   Other ""
  23                     Button "Cancel"
  24                     Button "Open"
...
```

The screenshot shows the alert `Open in “Agent Device Tester”?` with Cancel and Open. Both the
system-modal source and the app-alert source find it, so `expect` names both:

```json
"expect": {
  "blockingSystemModal": { "title": "Open in “Agent Device Tester”?", "buttons": ["Cancel", "Open"] },
  "appAlert": { "title": "Open in “Agent Device Tester”?", "buttons": ["Cancel", "Open"] }
}
```

Nodes 0, 1, and 2 are marked, and they form one branch. Node 2 is the innermost, and it kept node
3, the alert. The alert's controls are Cancel and Open. The tree has no other controls, so
`excludedActions` is empty:

```json
"expectModalScope": {
  "reading": "modal",
  "surfaces": [{ "host": 2, "roots": [3], "actions": ["Cancel", "Open"] }],
  "excludedActions": []
}
```

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
