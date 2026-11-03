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

**Write `expect` and `expectModalScope` from the screenshot: which node is the prompt on the
screen, and which buttons it offers.** The replay tests `ModalSurface` against them, so they
must not come from `ModalSurface`. `pnpm print:alert-surface` prints the rule's reading and
marks nodes. Use it only to find node indexes. Never copy its reading, a host, or a root without
checking each root and action against the screenshot.

1. Put the screen in the state you want with the session: open the app, `fold` for a folded pose,
   and raise the prompt.
2. Record the app that hosts the prompt. For a system alert, that is `com.apple.springboard`:

   ```bash
   pnpm capture:alert-surface --udid <udid> --bundle com.apple.springboard --name iphone-duo-folded-springboard-open-in-app
   ```

   Name the recording `<device>-<pose>-<app>-<prompt>`. The capture builds a runner with its own
   bundle id, so it runs beside the session's runner. If the screen changes between its reads, the
   capture fails. Wait until the prompt stops animating, then run it again.

3. Print the honor-modal tree, so you can find the prompt's nodes:

   ```bash
   pnpm print:alert-surface apple/snapshot-presentation/Tests/AlertSurfaceCorpus/iphone-duo-folded-springboard-open-in-app.json
   ```

   The command runs the Swift package's rule directly. Each line after the first shows a node's
   index, type, and label. `[surface roots: 3]` marks a modal host and lists its kept roots.
   The first line is what `ModalSurface` reads, labeled as the rule's answer, not ground truth.
   It is `modal`, `noExclusion`, or `unknown(<reason>)`. Hosts are marked only for `modal`. To print the whole tree, add `plain` after the path. If the
   recording does not load in the replay, the command stops with one line that names the problem.

4. Add `expect` from the screenshot. For each source that must find the prompt, give its title and
   buttons. The sources are `blockingSystemModal`, `appAlert`, `safariDialog`, and `dismissPopup`.
   A source you leave out must find nothing. Write `{}` for a screen with no prompt.
5. Add `expectModalScope` from the screenshot:
   - If the screen shows no prompt, write `{"reading": "noExclusion"}`.
   - If the screen shows a prompt, write `"reading": "modal"` and one surface for each prompt.
     Find the prompt in the printed tree by its type and labels. Its `roots` are the kept nodes
     that hold the prompt, and its `host` is their parent: the node where the honor-modal tree
     removed the rest of the screen. `actions` are the labels of the prompt's controls, in the
     printed order. Empty labels count. Add `excludedActions`: the labels of the honor-modal
     tree's controls that the prompt does not offer, such as a toolbar that stays visible.
   - Then compare the rule's reading on the first line with what you wrote. If they differ, look
     at the screenshot again. If the screenshot supports what you wrote, the rule is wrong for this
     screen. Don't add the recording. Report the screen in an issue, and attach the recording.
   - If the first line reads `unknown(duplicatedChild)`, a node lists one element more than once
     and the honor-modal tree kept only some of the copies, so the rule can't tell which copy
     lost children. Inspect repeated AX `element` ids under the same parent in the recording. Write
     `{"reading": "unknown", "reason": "duplicatedChild"}` only after you confirm those copies in
     the recording.
   - If the first line reads `unknown` with any other reason, the replay rejects the recording.
     Capture the screen again. If the line stays, report it in an issue.
6. Run the replay:

   ```bash
   swift test --package-path apple/snapshot-presentation
   ```

Don't edit the trees by hand. Capture again instead. A recapture keeps `expect` and
`expectModalScope`, but it can move the indexes in `expectModalScope`. After a recapture, print the
recording again and review each index.

## Example: the SpringBoard "Open in app" alert

`iphone-duo-folded-springboard-open-in-app.json` records the alert that
`xcrun simctl openurl <udid> "agent-device-test-app://x"` raises on a folded iPhone Duo. The start
of its printout:

```text
ModalSurface reads (the rule's answer, not ground truth): modal
   0 Application ""
   1   Window ""
   2     Other ""  [surface roots: 3]
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

In the tree, node 3 is that alert: its type is `Alert` and its label is the title. Its buttons are
nodes 23 and 24, Cancel and Open, as on the screen. Node 2 holds the alert, and the honor-modal
tree removed node 2's other children, so `host` is 2 and `roots` is `[3]`. The screen shows no
other controls, so `excludedActions` is empty. The rule's reading on the first line is `modal`,
which agrees:

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
