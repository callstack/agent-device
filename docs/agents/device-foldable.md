# Foldable Apple verification

Before you change capture behavior on a multi-panel device, read ADR 0025.
- Panels: `xcrun devicectl device info displays --device <udid>` shows each integrated panel with
  `backlightState`; only the lit panel permits capture. In a scoped set, `simctl --set <set> spawn
  <udid> ~/.agent-device/fold-helper/<key>/fold-helper panels` reads it.
- Input routing: after each pose change, verify a fresh control. A successful synthesis
  acknowledgement does not prove a hit. Examine the runner and simulator `testmanagerd`/BackBoard
  logs for display identity and delivery.
- Surface identity: verify the window the runner booked, not only the panel the host named; it owns
  gesture coordinates and its target screen. Its `runner.log` markers are listed in ADR 0025 and
  each must name the lit panel, except `SYNTHESIZED_DISPATCH reference=(…)`, which names no display:
  compare it with the booked surface. A 226x155.3 reference frame is the status-bar window: the bug.
- Pose: `agent-device fold closed|half-open|open` sends private HID inside the simulator; the same
  helper reads the hinge back in `hinge` mode. After a fold, take another snapshot: folds invalidate
  refs and coordinates. Verify locally, Device Hub stopped and the simulator booted through `simctl
  boot`, in the default set and with `--ios-simulator-device-set`: all three poses, capture of the
  active panel, and an app interaction. Duo coverage stays local until GHA supports the runtime.
  After a fresh boot a closed hinge can keep the inner panel lit for over 30 seconds, so lit-panel
  state never settles a pose.
- Touch overlays export at the captured track size. A failed check keeps the raw file and `record
  stop` reports `overlayWarning`; `--hide-touches` is the raw-capture fallback.
- To launch on iOS 27.0/27.1, iOS 27 SDK apps need UIScene lifecycle.
- The iOS 27.1 runtime (24A94425) accepts only the iPhone Duo device type.
  For a non-foldable control, use another runtime.
