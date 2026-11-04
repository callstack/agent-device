# ADR 0035: Host-Scoped Devices: macOS App Devices and Web Session Devices

## Status

Accepted (2026-10-21). Amended (2026-11-04): scope change. This ADR no longer applies to macOS only.
It defines host-scoped devices, of which macOS app devices (native backend, ADR 0031) and web session
devices are the two kinds. Rules 1 to 3 and 5 to 7 describe macOS app devices; rule 4 covers both
kinds; rules 8 to 11 describe web session devices.

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
4. One rule relates a host-scoped device to its host: the host and each of its host-scoped devices
   overlap, and two host-scoped devices do not (`devicesOverlap`). The session store finds a session
   on an overlapping device, and a claim selector (`device status --udid`) matches overlapping claims.
   In the claim store, a host-scoped device acquisition holds the host key's lock and refuses a live
   host claim; a host acquisition settles the claims of its host-scoped devices and refuses a live
   one, including this daemon's own. An unreadable claim file refuses a host acquisition. The rule
   reads the host from the device id (`hostDeviceIdOf`, `isHostScopedDeviceOf`), never from
   `DeviceInfo.hostApp`, for every host that can hold such devices (`canHostScopedDevices`: macOS and
   web). The `devices` `claimedBy` projection follows it: a host shows as claimed while one of its
   host-scoped devices is.
5. An app device acts on its own app only. It opens in the background (`open -g`), so the frontmost
   app and every other session's app stay where they are. It opens and closes only its own app, and
   a link alone opens in that app. It keeps the `app` surface. The clipboard, host settings, and the
   system audio probe belong to the whole Mac, so an app device refuses them with
   `reason: 'unsupported-device-scope'`.
6. A `macos-app` lease (ADR 0007) binds the app device of its bundle and takes its claim like any
   other session.
7. Helper screenshots take a host-wide lock (`macos-screen-capture.lock` in the claims directory) for
   one capture: ScreenCaptureKit fails or hangs when two processes capture at once.
8. A web session is a device: the web host (`agent-browser-chrome`) holds one web session device per
   session name, with id `<web host id>:session:<backend key>`. Every local web command binds the
   session device of its request; without `--session` the implicit session name (`default`) applies.
   The web host is never bound: it stays an inventory entry and the parent for `devicesOverlap`. The
   lock plan and the bound device name the same device, so two sessions with different names run in
   parallel and two with one name conflict, in one daemon or in daemons that share a claims directory.
9. A web session name is trimmed and must match `[A-Za-z0-9_-]`, non-empty, and short enough that its
   backend key fits agent-browser's socket path limit: at most 30 characters, and 17 under tenant
   isolation. Any other name is refused with `INVALID_ARGS`, `reason: 'web_session_name_invalid'`.
10. The backend key is `p_<name>`, or `t_<first 12 hex of sha256(tenant id)>_<name>` under tenant
    isolation, so two tenants using one name hold two devices and two browsers. The kernel derives it
    once (`webSessionDevice`) from the tenant-relative public name and the tenant id, never from the
    tenant-prefixed store name. The provider and teardown read it back from the device id
    (`webBackendKeyOf`) and pass it to agent-browser as `--session`.
11. First opens serialize on the host for an app device and on the device itself otherwise, so web
    session opens of one host run in parallel.

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

**Web sessions are devices.** agent-browser isolates a browser per `--session`, so the session is
the unit to lock, claim, and refuse on conflict. One host device serialized every web session.

**One name rule, one key.** The name rule is the backend's own: agent-browser accepts only
`[A-Za-z0-9_-]` and refuses a socket path over 103 bytes (65 bytes of socket directory on macOS
leave 32 characters of key). The kernel derives the key next to `hostAppDeviceId`, and every other
reader takes it from the device id. Under tenant isolation the key carries a fixed-width hash
prefix: a tenant id may hold `.` and 128 characters, which the backend refuses.

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
- **Readable `<tenant>/<name>` web ids with reserved prefixes.** The backend refuses `/`, `:`, and
  `.`, tenant ids can exceed the socket budget, and a reserved prefix is a rule the public name
  would have to keep refusing.
- **One shared browser per tenant.** Two sessions of a tenant would share cookies and storage, and
  one name would no longer mean one device.
- **The key as a `contracts` type, or derived in `platform-web`.** The key never crosses the wire (the
  device id carries it), and device selection would depend on a platform package.
- **Host-level web commands that lock the host.** They serialize every web session and bind a device
  that no session claim covers, so a host claim and a session claim could not exclude each other.
- **Keying web first opens by the host (rule 11).** The per-host lock separates a whole-host open
  from a sub-device open, and the web host has no whole-host open, so it would serialize web opens
  for no exclusion.

## Open gaps

- Implicit sessions of different workspaces share the web name `default`, because the key derives
  from the public name, not the workspace-scoped store key. This is an open question for the
  maintainer.
- A web open is admitted under a lease of any other backend (`ios-simulator` by default), because
  lease admission never compares platform with lease backend. This predates this amendment and is
  an open question.
- The 32-character key limit assumes the 48-byte macOS temporary directory; a longer `TMPDIR` makes
  agent-browser refuse earlier with its own error.

## Support boundary

A daemon older than this ADR does not scan app device claims on a whole-Mac acquisition, and a
daemon older than the web amendment claims the web host itself and does not scan web session
claims. Run one version per claims directory, as ADR 0030 requires for process locks.
