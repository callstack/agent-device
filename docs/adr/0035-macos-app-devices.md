# ADR 0035: macOS App Devices

## Status

Accepted (2026-10-21). Applies to the native macOS app backend (ADR 0031) only.

## Rules at a glance

1. With the native backend, an `open <app>` on the `app` surface selects an app device: one app of
   the host Mac, held as a device of its own. Its id is `<mac id>:app:<bundle id>`, lowercased, and
   `DeviceInfo.hostApp` names its host and bundle id. Device selection resolves the app before any
   lock, so the request's execution lock, claim, and session all name the app device.
2. Every other macOS session keeps the whole Mac: the XCTest backend, the `desktop`, `menubar`, and
   `frontmost-app` surfaces, and an open of a link alone.
3. Every per-device rule applies to an app device unchanged: the execution lock, the claim, the
   new-session conflict check, and `open --wait`. Two sessions on two apps run in parallel, in one
   daemon or in several daemons that share a claims directory. Two sessions on one app conflict.
   A fresh `open` of an app device takes its host's execution lock first, in its lock plan, so an
   `open --wait` looks at the Mac's sessions under a lock a whole-Mac open also takes. The first
   opens on one Mac run their session check and publication one at a time in a daemon. Commands of
   an open app session take only the app device's lock, and so does a replay or batch for the device
   it starts on, since it holds its locks for its whole run. A fresh batch that selects the Mac itself, with no app
   target, therefore holds the Mac's lock for its run. A request that already holds a lock on a Mac or one of its apps, itself or through the request it
   runs in (a batch step), takes another lock on that Mac only while it is free, and is otherwise
   refused with `DEVICE_IN_USE` (`DEVICE_EXECUTION_LOCK_BUSY`) instead of waiting. Waiting could
   cross a request that does the same in the other order: batches or replays on two apps that each
   close their app and open the other, or one that leaves its app for the whole Mac while a fresh
   open holds the Mac. With the whole Mac as one device, such requests shared one lock.
4. One rule relates an app device to its host: the Mac and each of its app devices overlap, and two
   app devices do not (`devicesOverlap`). The session store finds a session on an overlapping device,
   and a claim selector (`device status --udid`) matches overlapping claims.
   In the claim store, an app device acquisition holds the host key's lock and refuses a live host
   claim; a host acquisition settles the claims of its app devices and refuses a live one, including
   this daemon's own. An unreadable claim file refuses a host acquisition.
5. An app device acts on its own app only. It opens in the background (`open -g`), so the frontmost
   app and every other session's app stay where they are. It opens and closes only its own app, and
   a link alone opens in that app. It keeps the `app` surface. The clipboard, host settings, and the
   system audio probe belong to the whole Mac, so an app device refuses them with
   `reason: 'unsupported-device-scope'`.
6. A `macos-app` lease (ADR 0007) binds the app device of its bundle and takes its claim like any
   other session.
7. Helper screenshots take a host-wide lock (`macos-screen-capture.lock` in the claims directory) for
   one capture: ScreenCaptureKit fails or hangs when two processes capture at once.

## Context

Many agents run many apps on one Mac, and by default they share one daemon. The native backend acts
on the session app alone: accessibility actions on its elements, key events posted to its process,
and its window capture. None of those moves the real pointer or changes the frontmost app, so two
sessions on two apps cannot interfere through focus or the pointer. With the whole Mac as one device,
one session per Mac could automate any app, and two agents on two apps had to wait for each other.

## Decision details

**The app is the device.** Every lock, claim, conflict check, and wait is per device. When the app is
the device, they all exclude the right thing without a second scope beside the device, and a
`macos-app` lease needs no special case.

**Bundle id, not pid.** The helper resolves its target app by bundle id, so two processes of one
bundle id are one target. Two copies of one app need two bundle ids.

**Resolved before the lock.** The bundle id comes from host-level app resolution during device
selection. The advisory lock plan and the locked open select the same device, so an open never holds
the Mac's lock for an app device. An open whose app does not resolve fails as it did before.

**Known limit.** UI that another process owns, such as a system permission prompt, is not part of the
app device. Use a `desktop` session for it.

## Rejected alternatives

- **An app scope on the Mac device.** The first version kept the Mac as one device and added an app
  claim beside it. It needed its own conflict predicate, a two-phase `open --wait`, a bridge between
  app claims and app leases, and a reopen guard. Commands of two app sessions in one daemon still
  serialized on the Mac's execution lock.
- **A host-wide input lock around every action.** Native actions need neither focus nor the pointer.
  Only helper capture contends, on ScreenCaptureKit.
- **A separate claims directory per app.** Two stores could not exclude each other under one lock.

## Support boundary

A daemon older than this ADR does not scan app device claims on a whole-Mac acquisition. Run one
version per claims directory, as ADR 0030 requires for process locks.
