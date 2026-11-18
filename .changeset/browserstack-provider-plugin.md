---
'agent-device': minor
---

Extract BrowserStack out of the bundled WebDriver provider into the new `@agent-device/browserstack` plugin package, which publishes on the `nightly-0.22` tag. Install it with `agent-device plugins add @agent-device/browserstack@nightly-0.22`, or with the exact version a missing-plugin error names for the release you run, then close your sessions and run `agent-device daemon stop --state-dir <path>` for your daemon before reconnecting. Commands for a saved BrowserStack connection keep working while the plugin is installed; without it, `connect browserstack` explains how to install the plugin.
