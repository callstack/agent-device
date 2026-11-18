---
'agent-device': minor
---

Extract BrowserStack out of the bundled WebDriver provider into the new `@agent-device/browserstack` plugin package. Install it with `agent-device plugins add @agent-device/browserstack`, then close your sessions and run `agent-device daemon stop --state-dir <path>` for your daemon before reconnecting. Commands for a saved BrowserStack connection keep working while the plugin is installed; without it, `connect browserstack` explains how to install the plugin.
