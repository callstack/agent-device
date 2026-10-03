# #2682 — target activation disclosure: settled policy

Prototype branch `apex/2682-proto` (throwaway, not shipped). Lane: dedicated iPhone 17 Pro
simulator `apex-2682-proto` (`C2748D97-B92D-4B3B-9C65-AF86494AD904`), iOS 26.2, fixture
`com.callstack.agentdevicelab`. Physical `thymikee-iphone` untouched.

## Policy

**Ship (a): the runner keeps re-activating and discloses it. The (a) prior is CONFIRMED.**

Reproduced on the simulator: an off-app handoff (`xcrun simctl openurl <udid>
https://example.com` — the LaunchServices path an in-app external link takes) put MobileSafari in
the foreground. `screenshot` returned Safari's `Example Domain` page, status bar reading
"◀ Agent Device Tes…". The next `snapshot -i` returned `@e1 [application] "Agent Device Tester" …
@e13 [button] "Home"` — the session app — and said nothing about why. The only record anywhere was
`AGENT_DEVICE_RUNNER_ACTIVATE … state=2 reason=bundle_changed` in `runner.log`. The agent's own two
observations contradicted each other silently.

Latency is not the reason to prefer (a) — disclosure is free there. The state is already read before
`activate()` runs (`RunnerTests+Lifecycle.swift:205`, for the existing NSLog), so the emit sits
inside the branch that already pays `activate()` (measured 36–48 ms). The happy path never enters
that branch: five already-foreground `snapshot -i` runs measured 221–240 ms against 245–262 ms
before the change, and carry no field. (b) would break the screenshot→snapshot flow callers already
use and needs per-caller recovery; (a) preserves behavior and PR1 ships alone.

## Foreground identity: ship `priorState` + `otherActiveApplicationPid`, not a foreground owner

`XCAXClient_iOS` on this runtime answers `activeApplications` and `systemApplication` only;
`frontmostApplication` and `focusedApplication` do not exist there. Each element exposes
`processIdentifier` and nothing else — no `bundleIdentifier`, `executablePath`, `active`, or `state`.
The bundle id is reachable only by escalating: `proc_pidpath(pid)` (no iOS SDK header; symbol
declared by hand) → `NSBundle` → `com.apple.mobilesafari`, cross-checked against host `ps` for the
same pid. That is a new private surface with unknown physical-device behavior, and
`activeApplications` has no proven ordering to identify which element is foreground. So PR1 states a
pid, and only when exactly one foreign application is AX-active; it never guesses a bundle id.

Adversarial review (PR1/PR2) caught the naming over-claiming what that probe proves: with no ordering
in `activeApplications`, the pid establishes only that exactly one other application held an active
accessibility session at that moment — a liveness claim, not a foreground owner. The field is therefore
`otherActiveApplicationPid` and the sentence says the same thing the value proves. `priorState` is
unaffected: it is `XCUIApplication.state` read before `activate()` ran, which is a real fact about the
session app.

## Disclosure as it lands (same simulator, PR1 head)

```
The session app was not foreground when this command arrived (prior state runningBackground), so
the runner activated it before answering (reason stale_target). Any capture taken earlier in this
session described the only app other than the session app with an active accessibility session
(pid 33878), not the session app. Re-capture now that the session app answers, or drive the other
app in its own session.
```

pid 33878 resolved to `…/MobileSafari.app/MobileSafari` by host `ps`. The immediately following
`snapshot -i`, with the app already foreground, carries no disclosure — the fact belongs to the
command that paid for it. `test/integration/smoke-ios-target-activation.test.ts` runs the whole
sequence as an env-gated live lane and passes on this simulator.
