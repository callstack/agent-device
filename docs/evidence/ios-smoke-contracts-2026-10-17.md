# iOS smoke contracts

Authoring rules live in [iOS smoke authoring](../agents/ios-smoke.md). This file records the failures and verification behind PR #3786.

## Failure evidence

- [Run 39029845932](https://github.com/callstack/agent-device/actions/runs/39029845932): source-CLI runner preflight exhausted the daemon's 15-second startup budget. Its uploaded daemon log was empty; the log alone cannot identify why startup was slow. The lane now exercises the packaged entry point throughout without changing the daemon timeout.
- [Run 39027567868](https://github.com/callstack/agent-device/actions/runs/39027567868): step 84 failed in CoreSimulator URL delivery before any depth assertion. The depth scenario now enters through the fixture's Settings screen.
- [Run 39030211303](https://github.com/callstack/agent-device/actions/runs/39030211303): five destination waits found no app process. The failure screenshot showed an unanswered “Open in” confirmation. Waiting for a destination cannot answer a system prompt. The dedicated deep-link scenario retains this signal; it no longer prevents unrelated interaction tests from running.
- The original masked XCTest reproduced locally on iOS 27.0: the prefilled field showed 13 bullets instead of the asserted 8. This is not proof of failed delivery: the route explicitly returns unverified. The replacement assertion was stronger than its production contract. The new app-owned delivery canary distinguishes successful posting from missing or truncated input without claiming the old value was cleared.

## Verification results

Device: iPhone 17 Pro, iOS 27.0, UDID `BC54AC11-CD86-4C10-8C4E-5101C773FFEB`. Fixture: a fresh Release build of this checkout, with current JavaScript embedded. CLI and runner builds completed locally. CI still owns its iOS 26.2 environment.

- Native source at `92db564a30ec0ff39aa248339b45b12901a1ead8`: the original masked XCTest pair produced one pass and one failure; the prefilled synthesized case observed 13 bullets versus the asserted 8.
- Revised native fixture and XCTest assertions: five focused tests passed, including both masked cases, exact readable replacement past dropped select-alls, shared unreadable classification, and bounded masked clearing. `pnpm check:xctest-selection` reached every declared regression.
- Harness source at `83af5f485e12e16ff23bcc5606282633cad4a1f9`: the isolated-session smoke command passed 22 tests, zero failures/skips, in 130 seconds.
- Final harness source at `31e6941b991d4f3421b8c306535472a61408ec36`: the same smoke command passed 22 tests, zero failures/skips, in 112 seconds. The seven subtests covered inventory/install, automation input, form input and forced-backend conformance, visible depth, WebView remote content, deep-link/clear-state navigation, and screenshot/session release. Each run closed its sessions and stopped its daemon.
- Focused harness and coverage checks passed 24 tests. `pnpm check:quick`, fixture TypeScript checking, gate-manifest checking, and XCTest-selection checking passed.
- At `31e6941b991d4f3421b8c306535472a61408ec36`, an isolated mutation restored the old policy's retries for `wait_deadline_exceeded`. The focused test `a readable destination miss fails without repeating the wait` changed from one pass to one failure (`Missing expected rejection`). The experiment checkout was removed; the implementation checkout remained unchanged.
- Independent read-only review found one unnecessary trailing deep-link relaunch. It was removed, along with the analogous depth/WebView restores; the final follow-up review found no remaining issues.
