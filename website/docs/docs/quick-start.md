---
title: Quick Start
---

# Quick Start

For client-specific setup in Cursor, Codex, Claude Code, Windsurf, Cline, Goose, and other coding agents, see [AI Agent Setup](/docs/agent-setup). For a single text bundle that agents can ingest, use [llms-full.txt](https://oss.callstack.com/agent-device/llms-full.txt).

Every device automation follows this pattern:

```bash
# 1. Discover the installed app identifier when needed
agent-device apps --platform ios # or android

# 2. Navigate
agent-device open SampleApp --platform ios # or android

# 3. Snapshot to get element refs
agent-device snapshot -i
# Output:
# @e1 [heading] "Sample App"
# @e2 [button] "Settings"
# [off-screen below] 2 interactive items: "Privacy", "Battery"

# 4. Interact using refs
agent-device click @e2

# 5. Re-snapshot before next interactions; if a target only appears in an off-screen summary, scroll and re-snapshot first
agent-device snapshot -i

# 6. Optional: see structural changes since last baseline
agent-device diff snapshot
# or, from snapshot-focused help/examples:
agent-device snapshot --diff
```

React Native dev or debug builds often show warning or error overlays that can intercept taps or hide the real UI state. Check for them near app open and after major transitions. If they are not the requested behavior, dismiss them and continue, but mention them in your summary if you saw them.

Boot target if there is no ready device/simulator:

```bash
agent-device boot --platform ios # or android
# Android emulator launch by AVD name (GUI mode):
agent-device boot --platform android --device Pixel_9_Pro_XL
# Android headless emulator boot (AVD name):
agent-device boot --platform android --device Pixel_9_Pro_XL --headless
# Turn off a simulator/emulator when finished:
agent-device shutdown --platform ios
agent-device shutdown --platform android --device Pixel_9_Pro_XL
```

## Common commands

```bash
agent-device apps --platform android    # Discover the exact package name when unsure
agent-device capabilities --platform android # Discover target-supported commands for dynamic integrations
agent-device open SampleApp
agent-device snapshot -i                 # Get visible interactive elements with refs
agent-device diff snapshot               # Preferred exploration form for structural deltas
agent-device click @e2                   # Click by ref
agent-device fill @e3 "test@example.com" # Clear then type (Android verifies and retries once if needed)
agent-device press @e3
agent-device type " more" --delay-ms 80  # Append into the already focused field
agent-device get text @e1                # Get text content
agent-device screenshot page.png         # Save to specific path
agent-device install com.example.app ./build/app.apk     # Install app binary in-place
agent-device install-from-source https://example.com/builds/app.apk --platform android
agent-device reinstall com.example.app ./build/app.apk   # Fresh-state uninstall + install
agent-device shutdown --platform android --device Pixel_9_Pro_XL
agent-device close
```

`install`/`reinstall` binary format support:
- Android: `.apk` and `.aab`
- iOS: `.app` and `.ipa`
- `.aab` requires `bundletool` in `PATH`, or `AGENT_DEVICE_BUNDLETOOL_JAR=<absolute-path-to-bundletool-all.jar>` with `java` in `PATH`.
- `.aab` installs use bundletool `build-apks --mode universal`.
- `.ipa` installs extract `Payload/*.app`; if multiple app bundles exist, `<app>` selects the target by bundle id or bundle name.
- Use `install-from-source` for existing artifact URLs, including direct Android `.apk`/`.aab` URLs and trusted archives with one installable artifact. Use `install-from-source --github-actions-artifact <owner/repo:artifact>` for daemon-resolved GitHub Actions artifacts.

If `open` fails because no booted simulator/emulator/device is available, run `boot --platform ios|android` and retry.
If `open` fails because the app id is wrong or missing, run `apps` and retry with the discovered package or bundle id instead of guessing.

## Fast batching

When an agent already knows a short sequence of actions, batch them:

```bash
agent-device batch \
  --platform ios \
  --steps-file /tmp/batch-steps.json \
  --json
```

Example batch payload for a known chat flow:

```json
[
  { "command": "open", "input": { "app": "ChatApp", "platform": "android" } },
  { "command": "click", "input": { "target": { "kind": "selector", "selector": "label=\"Travel chat\"" } } },
  {
    "command": "wait",
    "input": { "kind": "selector", "selector": "label=\"Message\"", "timeoutMs": 3000 }
  },
  {
    "command": "fill",
    "input": {
      "target": { "kind": "selector", "selector": "label=\"Message\"" },
      "text": "Sent the update"
    }
  },
  { "command": "press", "input": { "target": { "kind": "selector", "selector": "label=\"Send\"" } } }
]
```

See [Batching](/docs/batching) for payload format, failure handling, and best practices.

## Semantic discovery

Use `find` for human-readable targeting without refs:

```bash
agent-device find "Sign In" click
agent-device find label "Email" fill "user@example.com"
agent-device find role button click
```

## Replay

For deterministic replay scripts and E2E guidance, see [Replay & E2E](/docs/replay-e2e).

## Scrolling

Navigate content that extends beyond the viewport:

```bash
agent-device scroll down 0.5            # Scroll down half screen
agent-device scroll up 0.3              # Scroll up 30%
agent-device scroll down --pixels 320   # Scroll down by a fixed distance
```

## Settings helpers

Toggle device settings directly:

```bash
agent-device settings wifi on
agent-device settings airplane on
agent-device settings appearance toggle
agent-device settings clear-app-state
agent-device settings location off
agent-device settings location set 37.3349 -122.009
agent-device settings permission grant camera
```

Note: iOS `settings` commands are simulator-only. On macOS, only `settings appearance ...` and `settings permission <grant|reset> <accessibility|screen-recording|input-monitoring>` are supported.

## JSON output

For programmatic parsing in scripts:

```bash
agent-device snapshot --json
agent-device get text @e1 --json
```

Note: The default snapshot text is an agent-facing, token-efficient view for planning and targeting actions. Use `--raw` or `--json` when you need the full provider tree.
