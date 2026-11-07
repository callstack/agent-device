---
'agent-device': patch
---

Revyl Android snapshots now name their producer `revyl-android-tree` instead of `appium-source`, so they are no longer confused with WebDriver's Appium page source. The new name shows in `snapshotDiagnostics.stats.backends`. Update `@agent-device/revyl` and `agent-device` together: an older `agent-device` does not know the new producer, so `wait stable` cannot settle on Revyl Android.
