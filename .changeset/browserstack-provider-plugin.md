---
'agent-device': minor
---

BrowserStack moves to the `@agent-device/browserstack` plugin. For a stable release, run `agent-device plugins add @agent-device/browserstack`. For a 0.22 nightly, use the matching install command shown by the CLI. Close your sessions and run `agent-device daemon stop --state-dir <path>` for your daemon before reconnecting. Commands for a saved BrowserStack connection keep working while the plugin is installed; without it, `connect browserstack` explains how to install the plugin.
