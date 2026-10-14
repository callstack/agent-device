# Changelog

## Unreleased

- Add `orientation auto` on ADB-backed Android (local and Limrun): it hands rotation back to the sensor by turning `accelerometer_rotation` on and leaving `user_rotation` alone, without waiting for the display to rotate, so a test that rotated to landscape can leave the device as it found it. Every other backend refuses it with `UNSUPPORTED_OPERATION`. The orientation input and result accept `auto` beside the four rotations.
- Carry provider keyboard facts through snapshots. Appium captures, including wait polls and fill pre-captures, add one sequential keyboard visibility probe with a 500 ms timeout. Probe results preserve tap-time docked-tree checks; unavailable probes leave visibility unknown.
