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
5. In one daemon, a session holds either one app (an app claim, or a `macos-app` lease, which
   takes no claim) or the whole device. Two sessions on the device conflict unless each holds one
   app and the apps differ. The new-session conflict check and the `open --wait` that queues on it
   decide with this one predicate, so a whole-device opener and a same-app opener wait for an app
   session and a different-app opener runs beside it. A per-app session may reopen only its app on
   the `app` surface; a link opens as `open <app> <url>`, because a bare URL's handler is not known
   before launch.
6. Helper screenshots take a host-wide lock (`macos-screen-capture.lock` in the device claims
   directory) for the length of one capture. It is the only action sessions on different apps
   serialize on.
7. App keys are lowercase, and the predicate of rule 5 compares bundle ids without regard to case,
   because LaunchServices matches them that way. An `open --wait` resolves the claim it would take
   under the device lock; until then it waits only for a whole-device session, and when the open
   then finds a conflicting app session it releases the lock and waits for that session too.

## Context

The Mac is one device, so its one claim let a single session per Mac drive any macOS app. The
native backend acts on the session app alone: accessibility actions on its elements, key events
posted to its process, window capture, and (rule 7 of ADR 0031) a background `open`. None of
those moves the real pointer or changes the frontmost app, so two sessions on two apps cannot
interfere through focus or the pointer. One host resource is shared: ScreenCaptureKit. Two helper
processes capturing two app windows at the same moment failed (`screenshot failed`, or both hung
until the 30 s helper timeout) in each of four attempts on macOS 27, while each capture alone took
about 0.5 s, so captures run one at a time.

## Decision details

**Bundle id, not pid.** The helper resolves its target app by bundle id, so two processes of one
bundle id are one target to every action. A pid in the key would let two sessions drive the same
windows. Liveness is the owning daemon's process, as for every claim. Two copies of one app need
two bundle ids.

**Key resolved before the claim.** The bundle id comes from the read-only open-target resolution,
before the claim and before launch. An open whose app cannot be resolved that early takes the
whole device rather than guessing.

**What stays whole-Mac.** Surfaces other than `app` post real pointer events or read every app.
Some commands still reach past the session app, as they did before this ADR: the clipboard and
appearance settings (host-global state), `close <other app>` (quits any app, including one another
daemon's session holds), and `settings permission` (opens System Settings in front).

**Background open follows the session's scope.** A session that holds one app opens it with
`open -g`, because bringing it forward would move the frontmost app under every other session.
A session that holds the whole Mac, including `open <app> --surface frontmost-app`, opens the app in
front as before.

## Rejected alternatives

- **An input lock around every action.** The native actions need neither focus nor the pointer
  once `open` stops activating, so a lock would only serialize sessions for nothing. Only the
  capture, which contends on ScreenCaptureKit rather than on input, is serialized.
- **A separate claims directory per app.** Two stores could not exclude each other under one
  lock, and every stale-claim path would need a second scan.

## Support boundary

A daemon older than this ADR reads a per-app record as inconsistent and never clears it, and its
whole-device acquisition does not scan per-app records. Run one version per claims directory, as
ADR 0030 requires for process locks.
