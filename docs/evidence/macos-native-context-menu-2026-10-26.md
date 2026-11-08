# macOS native backend: context menus and pointer fields

These measurements support the secondary click of the native macOS app backend ([ADR 0031](../adr/0031-macos-native-app-backend.md)) and item 13 of #3213.

## Setup

- macOS 27.0 (26A428), Apple Swift 6.4, MacBook host.
- A SwiftUI fixture app (`WindowGroup`) with these elements:
  - A `Text` row with `.contextMenu { Rename, Delete }`.
  - A `Button` with `.contextMenu { Copy Link }`.
  - A click counter `Button`.
  - A `Text` row with `.onTapGesture(count: 2)` that counts double-clicks.
  - A `ScrollView` page and a grouped `Form` page.
- The fixture opened with `open -g` and stayed behind the frontmost app for every run.

## `AXShowMenu`

- SwiftUI exposes `AXShowMenu` on every view with `.contextMenu`, and on `Button` next to `AXPress`.
  The double-click row exposes no action.
- `AXUIElementPerformAction(AXShowMenu)` on the row returned `kAXErrorCannotComplete` (-25204) after 1.5 s, and the menu opened.
  The app tracks the menu until it closes, so the reply waits for the default messaging timeout.
- The open menu is a window at layer 101 (`kCGPopUpMenuWindowLevel`) owned by the app.
  In the accessibility tree, the `AXMenu` is a child of the group that owns the row, inside the app window.
- `AXPress` on an `AXMenuItem` of the open menu ran the item's action and closed the menu.
- The frontmost app did not change.

Live run of the dev CLI on the fixture, with `AGENT_DEVICE_MACOS_APP_BACKEND=native`:

| Command | Result |
| --- | --- |
| `click @e11 --button secondary` on the row | `mechanism: ax-show-menu`, 1.4 s with the ghost cursor |
| `snapshot -i` | `[menu]` with `[menu-item] "Rename"` and `[menu-item] "Delete"` |
| `click @e16` on `Delete` | The fixture label changed to `delete`; the menu closed |
| `click @e12 --button secondary` on the button | The menu opened; the button action did not run |
| `click @e8 --button secondary` on the counter button | `UNSUPPORTED_OPERATION`, `helperReason: no-context-menu` |

## Pointer events with window fields

Each case posted mouse events with `CGEventPostToPid` and the target window number in field 51.
Each run read the target frame from the accessibility tree just before it posted.
Success is the fixture state change: the counter, the double-click count, or a new layer-101 menu window.

| Remaining context | Click | Double-click | Secondary click |
| --- | --- | --- | --- |
| Field 58 = 12345 | 0 of 3 | 0 of 3 | 0 of 3 |
| `CGEventSetWindowLocation` (window-local point) | 3 of 3 | 3 of 3 | 3 of 3 |

- With field 58 only, a double-click zoomed the window.
  AppKit read the event as a double-click on the title bar, at window-local (0, 0).
- In all 18 cases, the frontmost app and the real pointer position did not change.
- `CGEventSetWindowLocation` is not in the public SDK headers; the run resolved it with `dlsym`.
  It changed none of the public integer or double event fields 0 to 255.

This contradicts the 2026-10-05 measurement on macOS 26.6.2, where field 58 and the window-local location were interchangeable.
On macOS 27, only the unexported setter delivered pointer events to a background SwiftUI window.
