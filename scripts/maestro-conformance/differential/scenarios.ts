// Layer 3 — app-observable differential scenarios.
//
// A small set of flows run through BOTH real Maestro and agent-device on a live
// device. Opt-in/dispatch — never part of per-PR unit CI.
//
// These flows live in ./flows and target the real fixture app
// (examples/test-app, `com.callstack.agentdevicelab`), which the workflow builds
// and installs. They are deliberately NOT the layer-1 corpus: those flows exist
// only to be PARSED — they name a fictional `com.example.app` and elements that
// exist nowhere — so pointing a device run at them would fail before exercising
// any runtime behavior.
//
// Read the field names literally. Cross-engine comparison is OUTCOME parity (does
// the flow pass on both engines), which only catches a divergence severe enough
// to fail the flow. Anything finer — settle latching, retap counts, truncated
// pixel coordinates — is not visible to outcome parity, so where we can assert it
// we do it engine-side via `engineInvariants` over agent-device's own replay
// timing trace. Scenarios without invariants prove outcome parity ONLY; do not
// read more into them than that.
import { MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS } from '../../../src/compat/maestro/compatibility-policy.ts';
import type { Invariant } from './invariants.ts';

/** Bundle id of the fixture app the workflow installs before running scenarios. */
export const DIFFERENTIAL_APP_ID = 'com.callstack.agentdevicelab';

export type DifferentialOutcome = 'pass' | 'fail';

export type DifferentialScenario = {
  id: string;
  /** The #1217 bug class this scenario guards, when applicable. */
  bugClass?: 1 | 2 | 3 | 4;
  /** Corpus flow, relative to scripts/maestro-conformance/. */
  flow: string;
  /** Exactly what running both engines and comparing outcomes establishes. */
  comparesAcrossEngines: string;
  /** Expected outcome from BOTH engines when parity holds. */
  expect: DifferentialOutcome;
  /** Machine-checkable assertions over agent-device's own timing trace. */
  engineInvariants?: Invariant[];
  /** What a divergence would indicate. */
  divergenceMeans: string;
};

export const DIFFERENTIAL_SCENARIOS: DifferentialScenario[] = [
  {
    id: 'settle-after-tap',
    bugClass: 4,
    flow: 'differential/flows/settle-after-tap.yaml',
    comparesAcrossEngines: 'The tap succeeds on both engines.',
    expect: 'pass',
    // Outcome parity cannot see settle ordering: a tap that burns the whole
    // budget still passes. This invariant is the actual bug-class-4 detector.
    engineInvariants: [
      {
        kind: 'stepDurationBelow',
        command: 'tapOn',
        maxMs: MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS,
        because:
          'a tap consuming the entire settle budget means the stability loop never latched — the signature of a sleep-before-capture ordering regression',
      },
    ],
    divergenceMeans:
      'agent-device settled in a different order than upstream (sleep-before vs sleep-after capture) or never latches within the shared budget.',
  },
  {
    id: 'percent-truncation',
    bugClass: 1,
    flow: 'differential/flows/percent-swipe.yaml',
    comparesAcrossEngines:
      'The percentage swipe completes on both engines. NOTE: this does not compare the resolved pixel coordinates — truncation-vs-rounding is a 1px difference that outcome parity cannot see. Parse-level decimal rejection is covered by layer 1 (bug-classes/percent-decimal-swipe).',
    expect: 'pass',
    divergenceMeans: 'The swipe behaves differently enough on one engine to fail the flow.',
  },
  {
    id: 'tap-retry-if-no-change',
    flow: 'differential/flows/tap-retry-if-no-change.yaml',
    comparesAcrossEngines:
      'A retryTapIfNoChange tap succeeds on both engines. NOTE: the retap COUNT is not compared — the trace does not currently expose per-tap attempt counts.',
    expect: 'pass',
    divergenceMeans: 'agent-device fails a tap upstream completes (or vice versa) under retry-if-no-change.',
  },
  {
    id: 'optional-warned-not-failed',
    flow: 'differential/flows/optional-warned-not-failed.yaml',
    comparesAcrossEngines:
      'An optional assertion on an element that never exists is downgraded to a warning and the flow still completes on both engines — a failed-instead-of-warned classification flips the exit code, so outcome parity does prove this one.',
    expect: 'pass',
    divergenceMeans: 'agent-device failed an optional command upstream would have warned on.',
  },
];
