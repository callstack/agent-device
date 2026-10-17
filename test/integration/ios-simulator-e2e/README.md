# Author iOS smoke scenarios

Use this for `test/integration/ios-simulator-e2e/` and its native input regressions.
Use [test authoring](../../../docs/agents/test-authoring.md) for test boundaries and [device verification](../../../docs/agents/device-verification.md) for builds and cleanup.

## Declare the starting state

Register the scenario in `scenarios.ts` and bind its implementation in `live-runner.ts`.
Declare `setup` on every smoke scenario:

- `fixture-home`: the runner opens a fresh session, relaunches the fixture, and observes the home title and visible Form tab.
- `scenario-owned`: the scenario opens its own app or launch URL and observes its own first landmark.
- `no-session`: the scenario tests inventory or installation without opening an app.

For a form interaction scenario, use the existing registration pattern:

```ts
{ id: 'smoke:form-input', runner: 'formInput', tier: 'smoke', setup: 'fixture-home' }
```

Run commands serially on the selected device.
The runner closes the preceding session and assigns a distinct session to each smoke scenario.
Session recreation clears stored launch URLs; relaunch alone retains them.
Keep assertions inside the scenario's Node subtest.
Keep command and behavior coverage in their existing coverage registries.
The full tier remains a sequential journey with scenario-owned transitions; smoke setup metadata does not apply to it.

## Observe the behavior under test

Navigate through stable fixture controls when navigation is setup for another feature.
Keep URL delivery in the dedicated deep-link scenario.
Assert the route, event payload, clear-state data canary, and onward navigation there.
Observe its destination before checking for a system confirmation.
If the result carries `APP_NOT_RUNNING`, use `waitForDeepLinkDestination` to handle the exact fixture confirmation.
A typed absent alert needs no action; an unexpected prompt or alert failure fails the scenario.
Automatic confirmation remains covered by the launch-confirmation and lifecycle tests.

Use semantic readiness landmarks before interaction.
A title alone can precede the React tab controls.
Before testing keyboard dismissal, require the fixture's visible Done control.
Enable the simulator software keyboard for that lifecycle contract.
For intentionally truncated raw-depth assertions, validate the structural frontier; require semantic capture quality on regular and full-raw observations.
Use the built CLI for preparation and execution after building once.
Source and built clients have different daemon code signatures; alternating them can replace the daemon under test.
Use the built SDK with the existing-daemon transport for forced-backend probes.
Do not let a probe start or replace the daemon under test.

## Keep recovery bounded

Use `runStep` for the shared single-repeat observation policy.
Require both a retriable verdict and a typed prevented-observation reason.
Fail readable absence, exhausted readable waits, invalid selectors, and incorrect values.
If a helper owns retries, pass `reattemptInfrastructureMiss: undefined` on every attempt.
Keep cleanup retries in `retryCleanupStep`; return failed results with `allowFailure: true` so its typed already-clean handling applies on every attempt.
Capture exhausted cleanup failures through the shared harness before continuing cleanup.
Report them separately from scenario assertions.
Replay-suite attempt policies have their own owner; this step policy does not redefine them.

## Match input assertions to the contract

For masked unverified input, poll the app-owned delivery canary and assert zero password-toggle presses.
Require the canary to acknowledge the entire requested suffix.
Do not infer replacement or length from masking bullets.
For readable input, retain exact replacement assertions and deliberately dropped-select-all regressions.
Keep unreadable classification and bounded clearing in their owning policy tests.

## Verify simulator smoke changes

Read the live entry point's environment contract before running it.
Build a current Release fixture with embedded JavaScript for simulator smoke verification.
If a headless simulator minimizes its software keyboard, inspect its runtime setting:

```sh
xcrun simctl spawn <udid> defaults read com.apple.keyboard.preferences AutomaticMinimizationEnabled
xcrun simctl spawn <udid> defaults write com.apple.keyboard.preferences AutomaticMinimizationEnabled -bool false
```

The iOS workflow sets this before fixture smoke.
For local verification, record the prior value and restore it afterward.
Run the changed scenario through the checked-in smoke entry point and preserve its coverage and failure artifacts.
Record the source SHA, device, command, and semantic result under [device verification](../../../docs/agents/device-verification.md).
For regressions, prove the test fails without the fix using [isolated experiments](../../../docs/agents/test-experiments.md).
Do not count skipped device tests as passed.
