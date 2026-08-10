---
name: agent-device
description: Automates Apple-platform apps (iOS, tvOS, macOS), Android devices, and Amazon Vega OS TV apps in Vega Virtual Devices. Use when navigating apps, taking snapshots/screenshots where supported, driving TV remotes, tapping, typing, scrolling, extracting UI info, collecting evidence, or planning agent-device CLI commands.
---

# agent-device

For a normal app-driving task, start immediately. Do not probe first with `--help`, `--version`, `devices`, `appstate`, `snapshot`, or `screenshot`:

```bash
agent-device open <app> --foreground
```

That starts the session and returns the initial interactive snapshot with `@refs`.

Loop: act with `press|click|fill|longpress <target> ... --settle`, `scroll <direction> --settle`, or `back --settle`; continue from the printed diff, verify the named expectation (`wait text "..."`, `is`, `get`, or `find`), then run `agent-device close`.

Copy refs byte-for-byte: `@e12`, `@e12~s4` — keep the `@` and any `~sN`. Prefer current refs, then `id`/`label`/`role` selectors; coordinates are a last resort. If snapshot reports sparse/AX-unavailable, its refs and selectors are invalid: run `agent-device screenshot`, inspect the image, use coordinates, then retry `snapshot -i` after navigating. Otherwise run `snapshot -i` only when the diff lacks the next target.

Error output includes corrective hints; follow them instead of re-planning. Only when the task is specialized (for example gestures, scripting, TV, macOS, remote, or debugging) or a command shape is unclear, run `agent-device help <topic>`. `agent-device --help` lists topics, but is not a startup step.
