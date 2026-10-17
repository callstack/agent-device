# iOS smoke contracts

The merge gate must detect agent-device regressions on a controlled app. A command exit alone is not evidence of success. Each scenario owns semantic assertions and a known starting screen. Device commands run serially.

## Decisions

- Use the built CLI for runner preparation, replays, and fixture scenarios. Build once before preflight. A source client and a built client have different daemon code signatures; alternating them tests daemon replacement instead of the command under test. The forced-backend SDK probe sends to the existing daemon through the transport owner and cannot start or replace it.
- Report each smoke scenario as a Node subtest. Relaunch the installed fixture and observe its home screen before each UI scenario. Keep coverage accounting across the run. A failed subtest stays failed while later scenarios can produce independent evidence.
- Test deep links and stored-URL clear-state replay in their own smoke scenario. Assert the route, event name, payload, removed data canary, and onward navigation. Do not use URL delivery to set up snapshot depth or WebView capture tests. Navigate to those fixtures through stable app controls.
- Repeat destination observation only when typed runtime evidence says observation was prevented. A readable absence, invalid selector, or non-retriable failure ends the test. Limit retries to one, including callers that return the last failure instead of throwing. Disable the harness retry inside this owner so policies cannot multiply attempts.
- Test masked input against its unverified contract. Require the app to acknowledge receipt of the entire requested suffix and require zero password-toggle presses. Poll the independent app canary because synthesized posting does not promise synchronous commit. Do not infer replacement or character count from bullets. Readable-field regressions retain exact replacement assertions, including deliberately dropped select-alls; policy tests retain the unreadable classification and bounded clear behavior.

## Failure evidence

- [Run 39029845932](https://github.com/callstack/agent-device/actions/runs/39029845932): source-CLI runner preflight exhausted the daemon's 15-second startup budget. Its uploaded daemon log was empty; the log alone cannot identify why startup was slow. The lane now exercises the packaged entry point throughout without changing the daemon timeout.
- [Run 39027567868](https://github.com/callstack/agent-device/actions/runs/39027567868): step 84 failed in CoreSimulator URL delivery before any depth assertion. The depth scenario now enters through the fixture's Settings screen.
- [Run 39030211303](https://github.com/callstack/agent-device/actions/runs/39030211303): five destination waits found no app process. The failure screenshot showed an unanswered “Open in” confirmation. Waiting for a destination cannot answer a system prompt. The dedicated deep-link scenario retains this signal; it no longer prevents unrelated interaction tests from running.
- The original masked XCTest reproduced locally on iOS 27.0: the prefilled field showed 13 bullets instead of the asserted 8. This is not proof of failed delivery: the route explicitly returns unverified. The replacement assertion was stronger than its production contract. The new app-owned delivery canary distinguishes successful posting from missing or truncated input without claiming the old value was cleared.

## Local verification

Run the checked-in harness entry point with a current Release fixture, the selected simulator UDID, a purpose-specific state directory, and `AGENT_DEVICE_IOS_E2E=1 AGENT_DEVICE_IOS_E2E_TIER=smoke`. Build the CLI and unit-test-enabled XCTest runner first. The fixture must contain current JavaScript; an installed bundle ID is insufficient. Preserve the emitted coverage report and per-scenario evidence. Do not count skipped device tests as passed.
