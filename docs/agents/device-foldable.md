# Foldable Apple verification

Before you change capture behavior on a multi-panel device, read ADR 0025.
To list the panels, run `xcrun devicectl device info displays --device <udid>`.

- Panels: the command lists each integrated panel with `backlightState`. Only the lit panel permits capture.
  A capture of the dark panel exits 0 and writes an all-black PNG.
- Input routing: after each pose change, verify a fresh control.
  A successful synthesis acknowledgement does not prove a hit.
  Examine the runner and simulator `testmanagerd`/BackBoard logs for display identity and delivery.
  The resolved app window owns gesture coordinates and its target screen.
- Pose: `agent-device fold closed|half-open|open` sends private HID inside the simulator.
  It tries to read the hinge back through `devicectl device motion hinge-angle`.
  Device Hub and host Accessibility permission are not required.
  After a fold, take another snapshot. Folds invalidate refs and coordinates.
  Verify locally with Device Hub stopped and the simulator booted through `simctl boot`.
  Test these items:
  - All three poses.
  - Capture of the active panel.
  - An app interaction.
  Until GHA supports the runtime, Duo coverage remains local.
  devicectl 651.13.5 has no `device motion`. There, `fold` reports `fold-pose-dispatched-unverified`.
  To examine the pose, compare the lit panel from the panel list.
  The lit panel is evidence only. It cannot separate `half-open` from `open`.
- Touch overlays export at the captured track size.
  The compositor checks its output size and non-black content against the raw capture.
  If that check fails, `record stop` keeps the raw file. It reports `overlayWarning`.
  `record start --hide-touches` is only for the fastest raw capture.
- To launch on iOS 27.0/27.1, iOS 27 SDK apps need UIScene lifecycle.
- The iOS 27.1 runtime (24A94425) accepts only the iPhone Duo device type.
  For a non-foldable control, use another runtime.
