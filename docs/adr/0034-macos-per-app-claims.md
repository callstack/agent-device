# ADR 0034: macOS Per-App Device Claims

## Status

Accepted (2026-10-08). Applies to the native macOS app backend (ADR 0031) only. Numbered 0034
because 0032 and 0033 exist on main.

## Rules at a glance

1. A native macOS `app` session whose app resolves to a bundle id before launch claims
   `<device key>:app:<bundleId>` instead of the device key. Every other macOS session (XCTest,
   `desktop`, `menubar`, `frontmost-app`, an open of a URL alone) claims the device key. A
   `macos-app` lease still takes no claim (ADR 0007).
2. The per-app record is the process-owned v2 record with `app: { bundleId }`; it decodes only
   at the key derived from its identity and app. Classification, takeover, close, idle expiry,
   shutdown, the startup sweep, and `device release --stale` treat it like any claim.
3. Lock order is device key, then app key. Every acquisition on a device holds the device key's
   lock; a per-app acquisition takes the app key's lock inside it. Renew, clear, abandon, the
   sweep, and stale release take only their own key's lock and never create a claim.
4. A per-app acquisition settles the device key's claim first: a live foreign whole-device claim
   is a conflict. A whole-device acquisition on a macOS device scans the per-app claims of that
   device: dead or superseded owners are reconciled and removed, other foreign claims conflict,
   and this daemon's own are left to its session store.
5. In one daemon, a per-app open conflicts only with sessions on the whole device or on the same
   app. A per-app session may reopen only its app on the `app` surface.

## Context

The Mac is one device, so its one claim let a single session per Mac drive any macOS app. The
native backend acts on the session app alone: accessibility actions on its elements, key events
posted to its process, window capture, and (rule 7 of ADR 0031) a background `open`. None of
those moves the real pointer or changes the frontmost app, so two sessions on two apps cannot
interfere, and no action needs a short whole-Mac input lock.

## Decision details

**Bundle id, not pid.** The helper resolves its target app by bundle id, so two processes of one
bundle id are one target to every action. A pid in the key would let two sessions drive the same
windows. Liveness is the owning daemon's process, as for every claim. Two copies of one app need
two bundle ids.

**Key resolved before the claim.** The bundle id comes from the read-only open-target resolution,
before the claim and before launch. An open whose app cannot be resolved that early takes the
whole device rather than guessing.

**What stays whole-Mac.** Surfaces other than `app` post real pointer events or read every app.
The clipboard and appearance settings are host-global state that no claim protected before; a
per-app session can still reach them.

## Rejected alternatives

- **An input lock around every action.** The native actions need neither focus nor the pointer
  once `open` stops activating, so a lock would only serialize sessions for nothing.
- **A separate claims directory per app.** Two stores could not exclude each other under one
  lock, and every stale-claim path would need a second scan.

## Support boundary

A daemon older than this ADR reads a per-app record as inconsistent and never clears it, and its
whole-device acquisition does not scan per-app records. Run one version per claims directory, as
ADR 0030 requires for process locks.
