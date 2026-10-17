# iOS smoke contracts

Authoring rules live in [iOS smoke authoring](../../test/integration/ios-simulator-e2e/README.md). This file records the failures and verification behind PR #3786.

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

## Authoring audit follow-up

- At `87555e7543b8c55b27f66521808e4ebfd487f09e`, the simulator run exposed a keyboard-dismissal refusal and a raw depth-1 structural capture rejected as sparse. The unchanged harness at `5c7efc83eae318e78e1d637f0af2c0b41c59c9da` reproduced the same `UNSUPPORTED_OPERATION` at `dismiss input keyboard`. Its failure screenshot also showed no software keyboard. The selected simulator had `com.apple.keyboard.preferences AutomaticMinimizationEnabled=1`.
- With automatic minimization disabled, harness source `316052ba2e5c140ab54743212cbf79752851c7e1` passed the same simulator smoke command: **22 passed, zero failures/skips**, 102 seconds. The new visible-Done precondition, dismissal, refocus, and type assertions all executed. The workflow now establishes this keyboard setting before fixture smoke; local verification restores its prior value.
- The raw-depth assertion now accepts only a truncated `sparse-tree` containing Application/Window nodes. Root, depth-bound, and child-omission checks remain. Regular and full-raw captures still require semantic acquisition quality. Raw acquisition intentionally stops at the requested depth; structural sparsity there does not prove a failed capture of the full screen.
- Focused cleanup, destination, retry-policy, snapshot-acquisition, and coverage tests passed **49/49**. In a disposable checkout at `5c7efc83eae318e78e1d637f0af2c0b41c59c9da`, the new cleanup test `a returned cleanup failure on the third attempt is reported` failed because the old helper returned `undefined`. Applying the `live-harness.ts` fix changed the same command to **1 passed**. Both runs used `node --experimental-strip-types scripts/node-test-tmpdir.ts --test --test-name-pattern 'a returned cleanup failure on the third attempt is reported' test/integration/ios-simulator-e2e-cleanup.test.ts`. The experiment checkout was removed; the implementation checkout was unchanged by the experiment.
- Independent review accepted the authoring and declarative-setup changes. Its follow-up identified the raw-depth and keyboard-readiness assumptions; both were corrected and the next review found no remaining issues.

## Review follow-up after rebase

The published `b78ff238247774a1eb98afa74894340c78b26118` passed all 18 reported checks, including iOS 26.2 smoke, before this follow-up. Its local simulator result remains attributed to harness source `316052ba2e5c140ab54743212cbf79752851c7e1`; it is not a new simulator run at the rebased head.

Rebased onto `6e8c2a046cebb4729aad92a63c55f8f53f16579d`. Range-diff retained the runtime/test changes and preserved the upstream device-verification instruction when resolving its documentation conflict. Follow-up source `360ae21bfb41f3e54f73616669ab63b3d7fffecf` passed **32/32** focused destination, cleanup, and shared-harness tests. Exhausted cleanup captures evidence through the shared recorder without reissuing its command or losing final-attempt typed already-clean handling. The native change only restores the prefilled-case assertion diagnostic.

In a disposable checkout at the rebased pre-fix `b274ace553`, replacing the prompt-title assertion with an unrelated `Error` left the old unrelated-prompt test green (**1 passed**). Applying only the new matcher made the same mutation fail (**1 failed**) for the unexpected error name/message. Removing the mutation made the updated test pass (**1 passed**). All three runs used `node --experimental-strip-types scripts/node-test-tmpdir.ts --test --test-name-pattern 'an unrelated prompt or an unreadable alert' test/integration/ios-simulator-e2e-deep-link-destination.test.ts`. The disposable checkout was removed and the implementation checkout remained unchanged by the experiment. Independent read-only review found no remaining issues in the fixes or rebase range-diff.
