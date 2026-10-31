# Foldable Apple verification

Before you change capture behavior on a multi-panel device, read ADR 0025.
To list the panels, run `xcrun devicectl device info displays --device <udid>`.
In a scoped set, run `xcrun simctl --set <set> spawn <udid> ~/.agent-device/fold-helper/<key>/fold-helper panels`.

- Panels: the list shows each integrated panel with `backlightState`. Only the lit panel permits capture.
  A dark-panel capture exits 0 with an all-black PNG.
- Input routing: after each pose change, verify a fresh control.
  A successful synthesis acknowledgement does not prove a hit.
  Examine the runner and simulator `testmanagerd`/BackBoard logs for display identity and delivery.
- Surface identity: verify the window the runner booked, not only the panel the host named. It owns
  gesture coordinates and its target screen. In `runner.log`, `AGENT_DEVICE_RUNNER_PANEL_SURFACE`,
  `SYNTHESIZED_DISPATCH`, and `SYNTHESIZED_RECORD displayID=` must name the lit panel. A 226x155.3
  reference frame is the outer panel's status-bar window: the bug.
- Pose: `agent-device fold closed|half-open|open` sends private HID inside the simulator.
  The same helper reads the hinge back in `hinge` mode.
  After a fold, take another snapshot. Folds invalidate refs and coordinates.
  Verify locally with Device Hub stopped and the simulator booted through `simctl boot`.
  Test these items in the default set and with `--ios-simulator-device-set`:
  - All three poses.
  - Capture of the active panel.
  - An app interaction.
  Until GHA supports the runtime, Duo coverage remains local.
  After a fresh boot, a closed hinge can keep the inner panel lit for over 30 seconds, so lit-panel
  state never settles a pose.
- Touch overlays export at the captured track size; a failed check reports `overlayWarning`.
- To launch on iOS 27.0/27.1, iOS 27 SDK apps need UIScene lifecycle.
- The iOS 27.1 runtime (24A94425) accepts only the iPhone Duo device type.
  For a non-foldable control, use another runtime.
