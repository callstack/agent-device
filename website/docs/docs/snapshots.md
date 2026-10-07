---
title: Snapshots
---

# Snapshots

Take a snapshot to read the UI as a structured tree and get refs (`@e1`, `@e2`, …) for the elements on
the current screen.

```bash
agent-device snapshot                    # Full accessibility tree
agent-device snapshot -i                 # Interactive elements only (recommended)
agent-device snapshot -d 3               # Limit depth to 3 levels
agent-device snapshot -s "Contacts"      # Scope to label/identifier
agent-device snapshot -i -d 5            # Combine options
agent-device snapshot --actions          # Name custom actions merged into elements (iOS simulator)
agent-device diff snapshot               # Preferred structural diff vs previous session baseline
agent-device snapshot --diff             # Alias for the same diff operation
```

| Option           | Description                                                                     |
| ---------------- | ------------------------------------------------------------------------------- |
| `--diff`         | Structural diff against the previous session baseline (alias for `diff snapshot`) |
| `-i`             | Interactive-only output                                                          |
| `-d <depth>`     | Limit tree depth                                                                 |
| `-s <scope>`     | Scope to label or identifier                                                     |
| `--raw`          | Full provider tree instead of the visible-first agent view                       |
| `--actions`      | Name the custom accessibility actions merged inside an element (iOS simulator)   |
| `--force-full`   | Re-emit the full tree even when it is unchanged since the previous snapshot      |
| `--timeout <ms>` | Maximum wall-clock time for the snapshot command                                 |

`--actions` limits:

- Works on iOS simulators only. Physical iOS devices, macOS, and Android targets reject the flag.
- It names the affordances an element merged away (iOS `UIAccessibilityCustomAction`, React Native
  `accessibilityActions`), so a card whose reply/options controls are not separate elements still
  lists them.
- You can read the names but not trigger them. To use an affordance, go through the element's detail
  screen, find the same control exposed as a labeled element elsewhere, or tap by coordinates from
  its rect.
- Each merged element costs one accessibility round trip, so the pass is opt-in and capped. When it
  cannot read every candidate, the response says how many it read. A missing list on an unread
  element does not mean the element has no actions.
- You can't combine it with `--raw`. The CLI, the Node client, and MCP all reject the pair with
  `INVALID_ARGS` before touching the device.

## Keep snapshots small and current

- iOS and Android produce the same kind of snapshot: visible elements first, refs you can act on
  now, and hints that point to hidden list content.
- Use `snapshot -i` by default in agent loops.
- On Android, repeating an unfiltered snapshot when nothing on screen changed (content or bounds) returns a short acknowledgement instead of the tree. `-i`, `-d`, `-s`, `--json`, and `--raw` always print full output. Add `--force-full` to get the full tree anyway.
- The default text output is a compact view for planning and targeting actions. It lists visible elements first and may collapse helper and accessibility noise. Use `--raw` or `--json` when you need the full provider tree.
- Off-screen interactive content is collapsed into summaries such as `[off-screen below] 3 interactive items: "Privacy", "Battery", "About"`.
- If your target only appears in an off-screen summary, run `scroll <direction>` and snapshot again until it is visible.
- When agent-device knows which container holds the hidden content, it shows the summary inside that scroll or list container, for example `[content above scroll-area hidden]` or `[content below list hidden]`.
- Summaries show only a few labels. Use `snapshot --raw` when you need the full off-screen tree.
- Add `-s "<label>"` (or `-s @ref`) to limit output to one part of the screen.
- Add `-d <depth>` when you only need the upper layers of the hierarchy.
- If `snapshot -i -d <n>` reports no interactive elements at that depth, retry once without `-d` instead of taking more shallow snapshots.
- Take a new snapshot after any UI change before you reuse refs.
- On Android, right after navigation or a submit, snapshot capture retries trees that look stale for a short time, and `@ref` interactions refresh during that window. If `snapshot -i` still disagrees with the screen, trust `screenshot`, wait briefly, and take one fresh snapshot instead of looping on stale ones.
- If Android animations make runs flaky, run `settings animations off` before the run and `settings animations on` after it.
- On a device cloud, the provider's driver reads the tree. A screen that never goes still — a looping video, a live ticker, continuous animation — can make that read run out of time while `screenshot` still works. When the request is cancelled, agent-device stops waiting and releases the session, but the provider may keep reading and hold up that session's queue. A larger `--timeout` does not extend the read, and `settings animations` is not available on hosted WebDriver sessions.
- Run `diff snapshot` between UI changes to check what changed with less output.
- `snapshot --diff` does the same thing; prefer `diff snapshot`.
- Use `--raw` only for troubleshooting, when you need the full tree instead of the visible-first view.

How `diff snapshot` and `snapshot --diff` behave:
- The first run records a baseline (`baselineInitialized: true` in JSON).
- Later runs print unified-style lines (`+` added, `-` removed, unchanged context) and update the baseline after each call.

## Example output

```bash
agent-device snapshot -i
# Output:
# Snapshot: 9 visible nodes (14 total)
# @e1 [application] "Contacts"
#   @e2 [window]
#     @e3 [other]
#   @e4 [other] "Lists"
#     @e5 [navigation-bar] "Lists"
#       @e6 [button] "Lists"
#       @e7 [text] "Contacts"
#     @e8 [other] "John Doe"
#       @e9 [other] "John Doe"
# [off-screen below] 2 interactive items: "All Contacts", "New List"
```

## Structured node fields (`--json`)

Every node in `snapshot --json` output carries `kind`, next to `type` when the platform reports one:

- `type` is the raw platform class, verbatim: `Button` / `StaticText` from XCUI, `android.widget.Button`
  from the Android hierarchy. It differs by platform for the same UI role.
- `kind` is the platform-neutral role shown in brackets in text output (`button`, `text-field`,
  `text`, `switch`, `link`, …). It is the same on every platform and backend, in both `snapshot`
  and `snapshot -i`, so text and JSON output always agree on a node's role.

```json
{ "ref": "e4", "type": "android.widget.Button", "kind": "button", "label": "Send code" }
{ "ref": "e40", "type": "Button", "role": "UIButton", "kind": "button", "label": "Continue to catalog" }
```

On iOS, `role` (when present) is the native AX class (`UIButton`), carried only on iOS nodes.
`kind` is the cross-platform role, present on every node on every platform.

`role=` selectors (and `find role=...`) match the `kind` vocabulary: a node whose `kind` is `text`
or `text-field` always matches `role=text` / `role=text-field`, the bracketed word a snapshot
shows for that node
([#3021](https://github.com/callstack/agent-device/issues/3021)). Older spellings — the raw leaf
classes `role=statictext`, `role=edittext`, `role=textview`, `role=searchfield`, and the rest of the
leaf vocabulary — still match during a deprecation window, each only on nodes that carried that
class (so `role=linearlayout` never matches a `FrameLayout` row the way a shared `group` alias
would). Use the `kind` spelling in your selectors; the leaf aliases are deprecated and will be
removed in a future breaking release.

## iOS capture behavior

You can't pick the capture backend. `--raw` switches between two strategies, and each strategy
decides which backends it tries.

- Regular (non-`--raw`) capture starts with the XCTest tree. When that comes back **sparse** for a
  screen XCTest cannot read, it retries with a query sweep and then, on simulators, a private
  accessibility backend.
- Retries stop when the capture budget runs out, and you get the best result captured so far.
- A failed or partial capture is reported as such instead of looking like an empty UI. A
  **recovered** capture warns that it fell back to another backend; you can keep working from it. A
  **sparse** capture reports that no backend could read the screen and points you to `screenshot`
  plus coordinate taps. Use `--json` and read `snapshotQuality` for the state, backend, and reason
  behind **degraded** output.
- A **sparse** `snapshot` takes that screenshot for you and returns its path as
  `fallbackScreenshotPath`, so you don't need a separate `screenshot` command. Remote clients
  download the image to the local machine before returning that path. When the screen was
  reachable but published no accessibility content at all, the warning also names it as a likely app
  accessibility bug — assistive technologies get the same empty tree. Reasons that describe a limit
  of this tool instead (a refused or budget-exhausted capture) are not attributed to the app.
- `--raw` starts from the XCTest tree and keeps capture failures strict, so an XCTest
  accessibility error surfaces as an error instead of an empty tree.
- Private-accessibility recovery and `--actions` work on simulators only. Physical iOS devices have
  no second backend to fall back to.

## Android node metadata

Android bounds are physical pixels, as the accessibility tree reports them, and so are the points
`press`, `fill`, and the gesture commands take. `androidSnapshot.pixelDensity` on a helper capture
is the display's physical pixels per density-independent pixel (a 420 dpi phone reports `2.625`,
including any `wm density` override). To work in dp, divide rects by it and multiply your points by
it. An older helper omits it. iOS already reports points, so iOS snapshots have no such factor.

`androidSnapshot.missingRootWindowTypes` lists the `AccessibilityWindowInfo` types of windows the
helper listed but could not serialize, for example because the window's root was null or reading its
tree failed (`2` is an input method window); `windowCount` counts only the windows it did serialize. It is empty
when every listed window was read. When it names an input method window, the capture reports the
keyboard band as unmeasurable rather than absent. An older helper omits it.

The Android keyboard band is the input method window's bounds, the box around the area it takes
touches in. On Android 13 (API 33) and later the helper also checks that this area is one rectangle.
A floating keyboard's is not (the panel plus the gesture strip, with app content between them), so the
band is reported as unmeasurable and taps fall back to the tree's own keyboard check. Earlier releases
cannot report the area, so their bounds are used as they are.

Android snapshot nodes and `get attrs` (including the digest response) carry the native
`selected`, `checked`, `heading`, `roleDescription`, `editable`, `password`, `hintShowing`,
`placeholder`, `selectionStart`, and `selectionEnd` facts whenever the accessibility tree reports
them. Explicit `false` and `0` are kept; an absent field means the fact was unavailable, not false.
`hintShowing` and `placeholder` need Android API 26 or later, `heading` API 28 or later.

- `selected` is the accessibility selected state an app sets on a control — the active bottom-tab or
  segmented-control item, or the chosen row of a list. Android reports it explicitly as `true` or
  `false`; an older helper APK omits the field, which means the answer is unavailable rather than
  unselected. Snapshot text marks the node `[selected]`, and `is selected`, a `selected=true`
  selector, and a Maestro `selected:` qualifier all match on it.
- `checked` is the checked state of a checkable control — a switch, a checkbox, a radio button, or a
  view an app marked checkable. Android reports it as `true` or `false` on those nodes only; a node
  that cannot be checked, or an older helper APK, omits the field. Snapshot text marks the node
  `[checked]` or `[unchecked]`, so a toggle that reads as plain text is one Android did not report as
  checkable.
- `heading` is the accessibility heading flag an app sets on a node, the way React Native's
  `accessibilityRole="header"` does on a plain `View`; it is present only as `true`.
- `roleDescription` is the localized role description an app sets beside the native class, verbatim
  (React Native writes `Tab`, `Tab List`, `Radio Group`, `Link`, `Menu`), when the class alone would
  not say what the control is. The `type` stays the class; a consumer maps the description to a role.
- `value: ""` is an explicitly empty accessibility text; a missing `value` means no text was
  reported. The text of an empty field is its hint on modern Android, so check `hintShowing`
  before reading `value` as the entered contents.
- `placeholder` is the field's hint text itself, present whether the field is empty or filled: an
  empty field shows it (`hintShowing: true`, and `value` repeats it), a filled field no longer does.
  A field without a hint omits it. iOS nodes carry the same fact from the field's
  `placeholderValue`, on every producer (the XCTest tree, the Simulator AX bridge, and the runner's
  private-AX reader). XCTest reports an empty field's placeholder as its `value` too, so a `value`
  equal to `placeholder` is either an empty field or one holding exactly that text; equality alone
  cannot tell them apart.
- `selectionStart`/`selectionEnd` are accessibility selection offsets. They are independent of
  `editable` (read-only selectable text exposes them too), they are not a character count, and
  they do not prove that a masked or secure value equals expected text.
