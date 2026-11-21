# macOS platform plugin extraction — measurements (2026-11-21)

Issue #4675 moves macOS desktop automation and the `macos-helper` Swift package out of the published
core into the managed platform plugin `@agent-device/macos`. This note records the measurements for
that change. The decision is in ADR 0034.

## Packed core size

Both trees were built from a clean worktree with `pnpm install --frozen-lockfile && pnpm build`, then
packed with `npm pack --ignore-scripts --json`. Neither build ran `pnpm build:package`, so neither
pack holds the packaged runner source or the Android helper artifacts. The comparison is valid for
the difference, not for the published total.

| Tree | Commit | Packed | Unpacked | Files |
| --- | --- | --- | --- | --- |
| `0.22` base | `80c44fe45e` | 1 638 382 B | 5 275 885 B | 645 |
| This change | `4dc93c9ff8` | 1 616 982 B | 5 188 827 B | 629 |
| Difference | | −21 400 B | −87 058 B | −16 |

The base pack holds 11 `apple/macos-helper` files (116 181 B). The changed pack holds none.
The `@agent-device/macos` tarball is 70 157 B packed, 26 files, about 308 KB unpacked.

The core keeps the shared Apple XCTest runner with its macOS wire cases and Swift desktop branches,
by the decision in #4675. That is why the JavaScript in `dist/src` changes by only −14 620 B: the
Apple owner still holds the runner routes, and the leaf port replaces the moved modules.

## Live check on a Mac

Host: macOS on Apple silicon, Xcode 27.1. The packed core was installed into an empty directory under
the repository `.tmp/`, with `AGENT_DEVICE_HOME` and `AGENT_DEVICE_STATE_DIR` inside it.

| Step | Result |
| --- | --- |
| `devices --platform macos`, no plugin | `UNSUPPORTED_PLATFORM`, `plugin-not-installed`, install hint |
| `plugins add ./macos.tgz` | installed, listed as `(apple)` |
| `devices --platform macos` | the host Mac, `target=desktop` |
| `open TextEdit --platform macos` | opened |
| `snapshot -i`, default XCTest backend | blocked: see below |
| `open`, `snapshot -i`, `screenshot`, `press @e33`, `close`, native backend | all succeeded |

The default XCTest backend did not start on this host. `prepare ios-runner --platform macos` answered
`COMMAND_FAILED: Runner did not accept connection (xcodebuild exited early)`, and the runner log
holds `Failed to initialize for UI testing: ... "Timed out while enabling automation mode."`. The
host has not authorized XCUITest Automation Mode. The runner is the shared core runner and this
change does not alter it. The permission was not granted and the check did not work around it.

With `AGENT_DEVICE_MACOS_APP_BACKEND=native`, the plugin built its helper from the packed
`macos-helper` source and served the whole flow: a 45-node interactive snapshot of TextEdit, a
1172x976 window screenshot, and a press on a snapshot ref. The daemon was stopped afterwards.
