# 0038: Network dump source selection

## Status

Accepted for this PR's sources (provider, app-log) and the device-identity gate. ADR 0037 (the iOS Simulator network capture probe) is proposed in #3928 and names `probe` and `app-log`; the `probe` row below and the cross-PR ordering are this record's proposal to it. Before both land, one record must own the enum: the PR that lands second amends its own record to the single enum and owner named here, or records a different order it can defend.

## Rules at a glance

- `network dump` answers from exactly one source, reported in its `source` field: `probe` (injected iOS native probe, 0037), `provider` (injected React Native JS capture, this record), or `app-log` (session app log, all sessions).
- The platform runtime owns the ordering. Each platform runtime lists its sources once per dump, takes the first that answers with entries, and builds the app-log scan with its own platform recovery around the rest. A source never reaches into another source's state.
- Injection policy: no capture installs in the app under test unless an explicit operator command arms it, and the command that arms says so. `open --capture-network` arms the iOS probe at launch (0037); the first `network dump` of a React Native app session with a Metro binding arms the JS capture and reports the arming note. Nothing arms from a background path.
- The React Native provider injects into one runtime only: the dev-server runtime of the session's app on the device named by the platform-composed Metro device identity. The identity is granted only when the platform proves the name marks one attachable device. Android lists every serial adb reports, in any state including offline and unauthorized, and reads each serial's properties; any unreadable read withholds the identity. Apple lists booted simulators in every simulator set the host can name — the device's own set, the default set, and the daemon operator's set — and the connected physical devices devicectl reports; an unreadable listing, an unreadable physical-device answer, or a set the host cannot reconcile with its own configuration withholds the identity. A withheld identity fails the provider closed with `metro-device-mismatch`; the dump still answers from the app log. The identity probe runs lazily inside a dump, so only a session whose transport declared a provider dump pays for the probe.

## Decision

The React Native JS capture is a `provider` source, preferred over the app log and preferred under the probe. When both injected sources are armed for one session (an iOS simulator app opened with `--capture-network` that also loads its bundle from Metro), the probe answers first: it names every URLSession request, including the JS capture's own and any native-transport traffic. The JS capture adds headers and bodies observed at the JS layer, so it answers when the probe is not armed. The app log answers last and always remains available.

Selection stays inside the platform runtime rather than a shared walker because the app-log fallbacks are not shareable: Apple recovers from `simctl log show`, Android from `adb logcat` with PID handling. A shared walker would need host slots per platform and would re-create that split behind an indirection.

## Reason

The provider answers with exact method, URL, status, duration, headers, and bodies, which the app log rarely names. The fail-closed device-identity rule exists because a runtime is selected by a name the dev server reports: two emulators of one system image, or two same-name simulators, report one name, and the weaker match let one session hook, drain, and report another device's traffic. The platform that owns the device inventory (adb device properties; `simctl list devices booted`) is the only layer that can say whether a name marks exactly one attached device.

Lazy arming of the JS capture keeps injection honest: code enters the app under test only because a `network dump` asked for it, the first window reads the app log with an explanatory note, and the same rule generalizes to the probe, which arms only under an explicit open flag.

## Rejected alternatives

- Arming the JS capture at `open` when Metro is bound. It injects before any command asks for network data and needs an attach-retry policy for cold-start races with the dev server.
- Selecting runtimes by a shared display name, model, or alias list. A name two attached devices share is not an identity; the review of #3930 showed one session draining another device's buffer that way. The platform now passes a composed identity only when it checked every attached device for a collision.
- Matching the dev server's `<model> - <release> - API <level>` report by model prefix. Same defect: same-image emulators collide on the prefix.
- Subscribing to the RN DevTools built-in Network CDP domain instead of injecting code. It needs a daemon-held CDP connection for the session's lifetime and drops React Native versions without the domain; the injected runtime is the version-agnostic core.

## Consequences

- A source field value is added only with its owner and its place in the order recorded here.
- A physical Apple device gets no Metro device identity (its dev-server-reported name has no host-side listing that proves which runtime it belongs to), so the React Native provider stays off there and the dump answers from the app log. Connected physical devices do count against a simulator's identity: a same-named one could attach to the same dev server.
- Accepted risk (Apple sets): `simctl` cannot enumerate simulator sets, so the identity check covers the sets the host can name — the device's own set, the default set, and the set `AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET` configures. A simulator booted in some other set whose path this host was never told about is invisible to every available tool and cannot be ruled out. Operators who share one dev server across simulator sets must keep simulator display names unique across those sets.
- The device-identity gate is a typed note on an `app-log` answer, never a command failure, so a selection problem degrades to the old capture instead of losing the dump.
