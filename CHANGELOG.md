# Changelog

## Unreleased

- Carry provider keyboard facts through snapshots. Appium captures, including wait polls and fill pre-captures, add one sequential keyboard visibility probe with a 500 ms timeout. Probe results preserve tap-time docked-tree checks; unavailable probes leave visibility unknown.
