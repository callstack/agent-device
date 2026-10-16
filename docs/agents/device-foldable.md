# Foldable Apple verification

Read ADR 0025 before changing capture behavior on a multi-panel device. The iOS 27.1 runtime ships
only with the Xcode that carries it, and `xcode-select` may point at an older one, so pin the
toolchain per command:
`DEVELOPER_DIR=<Xcode-27.1>/Contents/Developer xcrun devicectl device info displays --device <udid>`.

- Panels: that command lists each integrated panel with `backlightState`. Only the lit panel is
  capturable — a capture of the dark panel exits 0 and writes an all-black PNG.
- Input routing: verify a fresh control after each pose change. A successful synthesis acknowledgement
  does not prove a hit. Inspect the runner and simulator `testmanagerd`/BackBoard logs for display
  identity and delivery; the resolved app window owns gesture coordinates and its target screen.
- Pose: `agent-device fold closed|half-open|open` sends private HID inside the simulator and reads
  the hinge back through `devicectl device motion hinge-angle`. Device Hub and host Accessibility
  permission are not required. Re-snapshot afterwards: refs and coordinates do not survive folds.
  Verify locally with Device Hub stopped and the simulator booted through `simctl boot`; test all
  three poses, active panel capture, and an app interaction. Duo coverage remains local until GHA
  supports the runtime. To inspect the angle independently:
  `DEVELOPER_DIR=<Xcode-27.1>/Contents/Developer xcrun devicectl device motion hinge-angle --device <udid> --session-timeout 1 --timeout 5`.
- Touch overlays export at the captured track size. The compositor checks its output (size,
  non-black) against the raw capture; on failure `record stop` keeps the raw file and reports
  `overlayWarning`. `record start --hide-touches` is only for the fastest raw capture.
- iOS 27 SDK apps need UIScene lifecycle to launch on iOS 27.0/27.1.
- The 27.1 beta accepts only the iPhone Duo device type; use another runtime for a non-foldable control.
