# Changelog

## Unreleased

- Add `settings mobile-data on|off` for adb-backed Android targets. It switches mobile data through `svc data` and reports the `mobileData` state the device then stores, in the global `mobile_data` row or, when more than one modem is active, in `mobile_data<subId>` for the default data subscription. Every other target refuses it before anything runs, and `--app` is refused because the switch is device-wide.
- Carry provider keyboard facts through snapshots. Appium captures, including wait polls and fill pre-captures, add one sequential keyboard visibility probe with a 500 ms timeout. Probe results preserve tap-time docked-tree checks; unavailable probes leave visibility unknown.
