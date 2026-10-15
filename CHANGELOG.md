# Changelog

## Unreleased

- Limrun iOS snapshots no longer fail when the instance reports a numeric or boolean accessibility value (the system photo picker's tabs report `1`/`0`): the provider seam normalizes variant scalars to text, the way the Apple tree does. Limrun nodes now also publish `selected: true` for nodes carrying the `Selected` trait, so snapshot output and `selected:` selectors can tell a picked photo from an unpicked one.
- Carry provider keyboard facts through snapshots. Appium captures, including wait polls and fill pre-captures, add one sequential keyboard visibility probe with a 500 ms timeout. Probe results preserve tap-time docked-tree checks; unavailable probes leave visibility unknown.
