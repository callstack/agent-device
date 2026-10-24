# ADR 0037: iOS Simulator Network Capture Probe

## Status

Accepted (2026-10-23). Applies to iOS simulator app launches only.

## Rules at a glance

1. `open <app> --capture-network` on an iOS simulator injects `apple/network-capture/ADNetworkCapture.m`
   (built on demand, cached per content hash and toolchain) into the app process through
   `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES`. Admission follows the owner that dispatches the open, not
   the device shape, and it happens before the lifecycle touches the device: `assertOpenAdmitted`
   runs first in every `openApplication` entry, enforcing both the owner capability and the
   request shape of the launch-only options (the positional and URL-pair checks that need no
   device), so an owner that cannot inject the probe, or a launch-only option on a request that
   cannot carry one, is refused before its relaunch close, runner stop, or runtime-hint write — a
   refused open never kills a running app. Only the local Apple lifecycle on an iOS simulator
   declares the capability, so a provider-backed iOS simulator (Limrun, TestMu) refuses the flag
   instead of launching without capture. Every other platform and every URL open refuse the flag.
   `--launch-console` admits the same way, and the same local-Simulator declaration gates both.
2. The probe method-swizzles `-[NSURLSessionTask resume]`, observes each task to completion, and
   appends one JSON line per completed HTTP(S) task to the file named by
   `AGENT_DEVICE_NETWORK_CAPTURE_PATH` — the session's `network.jsonl`, one per session, replaced on
   every probe-injected launch. Each line carries the request's own URL, method, status, and
   duration, so a request that reused a keep-alive connection is named in full.
3. The capture launch always terminates a running instance first: injection happens at exec, so an
   already-running app would be activated without the probe.
4. A probe that cannot be built fails the open with `network-capture-probe-build-failed`. An open
   that asked for capture never silently launches without it.
5. `network dump` for a session with a capture window reads the probe file and reports
   `source: 'probe'`; a session opened without capture parses the app log and reports
   `source: 'app-log'`. These are the two modes, not a primary and a fallback. The dump states
   which source it used. Apple source precedence is fixed here for every Apple dump, including the
   Metro-backed provider dump added later: **probe, then provider, then app-log**. The probe wins
   because the operator asked for it on this open and it also sees React Native `fetch`, which runs
   on URLSession on iOS; the provider transport answers only when no probe window is open.
6. The probe file is host-side text an untrusted app wrote: reads are byte-bounded at the tail and
   pass through the operator's `AGENT_DEVICE_APP_LOG_REDACT_PATTERNS` before any response. The probe
   masks credential headers itself (`Authorization`, `Cookie`, `Set-Cookie`, and their
   authentication siblings) before writing, so a secret never enters the file and survives a dump
   run without operator patterns. File writes use `writeData:error:` and the cap check reads the
   handle offset through `getOffset:error:` rather than the raising `offsetInFile`: a capture
   failure must never crash the app under test. Writes stop at a 32 MB file cap, and the dump
   reports a note when the file has reached it, so a capped window is never read as current traffic.
7. The capture window names the app process the probe was injected into. If that app crashes and
   the runner relaunches it, the new process has no probe and writes nothing more; the dump of such
   a session keeps reporting `source: 'probe'` over the frozen entries. Reopen with
   `--capture-network` to capture again.

## Reason

CFNetwork logs a request URL only when a connection opens, so the app-log parser reports a
keep-alive request against its connection's origin with no path — the gap that forced the
`simctl log show` recovery pass and the unnamed-request notes. Observing each task inside the app
names every request the app itself made, without a proxy, without app changes, and without
entitlements; `simctl launch` forwards only `SIMCTL_CHILD_`-prefixed variables to the app, so
injection adds two variables and changes nothing else the app sees.

## Rejected alternatives

- **HTTP proxy (`simctl` supports none for the app's URLSession without app-side config).** A proxy
  needs per-app trust and proxy settings and does not cover certificate-pinned traffic.
- **Tuning `network dump` harder on Unified Logging.** The path is simply absent from the logs for a
  reused connection; no reader can recover it (ADR rationale already recorded in the parser notes).
- **Requiring the app to link a capture SDK.** This changes the artifact under test.
- **Launching without the probe when the build fails.** That silently answers the user's capture
  request with the weaker source; `AGENTS.md` forbids unapproved fallbacks.

## Consequences

- Capture covers URLSession only. A Flutter `dart:io` or other non-URLSession stack writes nothing;
  the dump's note says so.
- The probe binary builds with clang against `iphonesimulator` for both simulator architectures
  through the shared native-build cache, so a `DEVELOPER_DIR` switch rebuilds rather than serving a
  binary compiled against another SDK.
- `source` is a new field on the `network dump` response for Apple app-log dumps too, so a client
  can tell the modes apart without parsing notes.
