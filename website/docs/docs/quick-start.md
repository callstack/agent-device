---
title: Quick Start
---

# Quick Start

Open an app, read its UI, and interact with it from the command line.

Before you start, [install `agent-device`](/docs/installation) and the platform tools for your target: Xcode for iOS, the Android SDK and ADB for Android, or the HarmonyOS Command Line Tools for HarmonyOS. To set up Cursor, Codex, Claude Code, Windsurf, Cline, Goose, or another coding agent, see [AI Agent Setup](/docs/agent-setup). To give an agent the whole documentation as one text file, use [llms-full.txt](https://oss.callstack.com/agent-device/llms-full.txt).

Device automation follows this pattern:

```bash
# 1. Discover the installed app identifier when needed
agent-device apps --platform ios # or android or harmonyos

# 2. Open the app
agent-device open SampleApp --platform ios # or android or harmonyos

# 3. Snapshot to get element refs
agent-device snapshot -i
# Output:
# @e1 [heading] "Sample App"
# @e2 [button] "Settings"
# [off-screen below] 2 interactive items: "Privacy", "Battery"

# 4. Interact using refs
agent-device click @e2

# 5. Snapshot again before the next interaction; if a target only appears in an off-screen summary, scroll and snapshot again first
agent-device snapshot -i

# 6. Optional: see what changed since the last snapshot
agent-device diff snapshot
# or, from snapshot-focused help/examples:
agent-device snapshot --diff
```

React Native dev and debug builds often show warning or error overlays that can intercept taps or hide the real UI. Check for them after opening the app and after major transitions. If they aren't what you're testing, dismiss them and continue, and mention them in your summary.

If no device, simulator, or emulator is running, boot one:

```bash
agent-device boot --platform ios # or android
# Android emulator launch by AVD name (GUI mode):
agent-device boot --platform android --device Pixel_9_Pro_XL
# Android headless emulator boot (AVD name):
agent-device boot --platform android --device Pixel_9_Pro_XL --headless
# Shut down a simulator or emulator when finished:
agent-device shutdown --platform ios
agent-device shutdown --platform android --device Pixel_9_Pro_XL
```

## Common commands

```bash
agent-device apps --platform android    # Discover the exact package name when unsure
agent-device capabilities --platform android # List the commands this target supports
agent-device open SampleApp
agent-device snapshot -i                 # Get visible interactive elements with refs
agent-device diff snapshot               # Show what changed since the last snapshot
agent-device click @e2                   # Click by ref
agent-device fill @e3 "test@example.com" # Clear then type (Android verifies and retries once if needed)
agent-device press @e3
agent-device type " more" --delay-ms 80  # Append into the already focused field
agent-device get text @e1                # Get text content
agent-device screenshot page.png         # Save to a specific path
agent-device install com.example.app ./build/app.apk     # Install the app, keeping app data where supported
agent-device install-from-source https://example.com/builds/app.apk --platform android
agent-device reinstall com.example.app ./build/app.apk   # Uninstall, then install with fresh state
agent-device shutdown --platform android --device Pixel_9_Pro_XL
agent-device close
```

`install` and `reinstall` accept `.apk` and `.aab` on Android, `.app` and `.ipa` on iOS, and `.hap` on HarmonyOS. For `.aab` requirements, `.ipa` archives with several apps, and installing from a URL, see [App install](/docs/commands#app-install-in-place).

If `open` fails because no simulator, emulator, or device is booted, run `boot --platform ios|android` and retry.
If `open` fails because the app ID is wrong or missing, run `apps` and retry with the package name or bundle ID it lists.

## Run several steps in one command

When an agent already knows a short sequence of actions, send them as one batch:

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

See [Batching](/docs/batching) for the payload format, failure handling, and best practices.

## Find elements without refs

Use `find` to target elements by visible text, label, or role:

```bash
agent-device find "Sign In" click
agent-device find label "Email" fill "user@example.com"
agent-device find role button click
```

## Replay a flow

To record and replay deterministic scripts, see [Replay & E2E](/docs/replay-e2e).

## Scroll

Scroll to reach content outside the viewport:

```bash
agent-device scroll down 0.5            # Scroll down half screen
agent-device scroll up 0.3              # Scroll up 30%
agent-device scroll down --pixels 320   # Scroll down by a fixed distance
```

## Change device settings


```bash
agent-device settings wifi on
agent-device settings airplane on
agent-device settings appearance toggle
agent-device settings clear-app-state
agent-device settings location off
agent-device settings location set 37.3349 -122.009
agent-device settings permission grant camera
```

iOS `settings` commands work on simulators only. On macOS, only `settings appearance ...` and `settings permission <grant|reset> <accessibility|screen-recording|input-monitoring>` are supported.

## Get JSON output

Add `--json` to parse output in scripts:

```bash
agent-device snapshot --json
agent-device get text @e1 --json
```

The default snapshot text is a compact view meant for agents to plan and target actions. Use `--raw` or `--json` when you need the full provider tree.
