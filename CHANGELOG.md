# Changelog

## Unreleased

- Add `settings mobile-data on|off` for adb-backed Android targets. It switches mobile data through `svc data` and reports the `mobileData` state stored in the global `mobile_data` row; multi-SIM read-back is not covered yet. Every other target refuses it before anything runs, and `--app` is refused because the switch is device-wide.
- Limrun iOS snapshots no longer fail when the instance reports a numeric or boolean accessibility value (the system photo picker's tabs report `1`/`0`): the provider seam normalizes variant scalars to text, the way the Apple tree does. Limrun nodes now also publish `selected: true` for nodes carrying the `Selected` trait, so snapshot output and `selected:` selectors can tell a picked photo from an unpicked one.
- `settings` refuses a setting the target does not serve before anything changes, with `UNSUPPORTED_OPERATION`, `settings <setting> is not supported on this device`, and the target's `error.details.reason` (such as `unsupported-platform-leaf`). This replaces the macOS `INVALID_ARGS` refusal and the Apple `setting-unsupported-on-leaf` reason, and now also covers settings that used to reach the device first, such as Android `reset-keychain` or Apple `animations`.
- `settings` refuses, before touching the device, a state its setting does not accept (`Invalid <setting> state: …`), a permission action or mode its target does not take (such as `permission deny accessibility`), and a stray extra argument (such as `clear-app-state <app> <extra>`). The CLI and the daemon accept the same state spellings, in any casing or surrounding whitespace.
- `alert wait 0` on Android reports an alert that is already visible instead of timing out.
- `settings --help` describes each setting on its own line, and its usage folds settings that share a form.
- Carry provider keyboard facts through snapshots. Appium captures, including wait polls and fill pre-captures, add one sequential keyboard visibility probe with a 500 ms timeout. Probe results preserve tap-time docked-tree checks; unavailable probes leave visibility unknown.
