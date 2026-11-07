---
'agent-device': patch
---

Revyl Android snapshots now name their producer `revyl-android-tree` instead of `appium-source`, so they are no longer confused with WebDriver's Appium page source. The new name shows in `snapshotDiagnostics.stats.backends`. Update the Revyl plugin and the agent-device host together: a host older than this release has no quiet-window default for `revyl-android-tree`, so its `wait stable` would run without one.
