# Changelog

## Unreleased

- Add `settings mobile-data on|off` for adb-backed Android targets. It switches mobile data through `svc data` and reports the `mobileData` state read back from the global `mobile_data` setting (`mobile_data<subId>` on a multi-SIM device). Apple targets refuse it.
- Carry provider keyboard facts through snapshots. Appium captures, including wait polls and fill pre-captures, add one sequential keyboard visibility probe with a 500 ms timeout. Probe results preserve tap-time docked-tree checks; unavailable probes leave visibility unknown.
