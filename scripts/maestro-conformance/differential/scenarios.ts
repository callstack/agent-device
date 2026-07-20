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

/**
 * A divergence this scenario is currently EXPECTED to exhibit.
 *
 * This is the layer-3 twin of layer 1's FLOW_DIVERGENCES, and it exists for the
 * same reason: the oracle's contract is that every divergence is a decision on
 * the record, never a silent one. When the differential catches a real engine
 * bug, the instrument must not be blocked on repairing what it just measured —
 * declare it, file it, and let the scheduled run stay green on the known gap
 * while still failing on anything undeclared.
 *
 * `tracking` is REQUIRED and enforced by run.test.ts. A declared divergence with
 * no issue behind it is exactly how "temporarily expected" becomes permanent
 * without anyone deciding to make it so.
 */
/**
 * The EXACT failure a declaration covers.
 *
 * Without this a declaration is blanket amnesty: any failure at all would turn
 * the scenario green, so while a gap is open the job would also swallow an
 * unrelated regression — upstream Maestro starting to fail, or a different
 * invariant breaking. A waiver must cover the one failure it was granted for and
 * nothing else, so the signature is matched exactly and any deviation is red.
 */
export type DivergenceSignature = {
  /** Outcome each engine is expected to produce while the gap is open. */
  maestro: DifferentialOutcome;
  agentDevice: DifferentialOutcome;
  /** Expected status of each declared engine invariant, in declaration order. */
  invariants?: Array<'held' | 'violated' | 'no-data'>;
};

export type KnownDivergence = {
  /** Why this scenario currently fails, and what it blocks. */
  reason: string;
  /** Issue tracking the fix. Required — see above. */
  tracking: string;
  /** The precise failure this waiver covers. Anything else stays red. */
  expected: DivergenceSignature;
};

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
  /**
   * Declared, tracked failure. The run stays green while this holds — but it
   * FAILS if the scenario starts passing, so the fix PR must remove the
   * declaration and the oracle enforces that the gap stays closed.
   */
  knownDivergence?: KnownDivergence;
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
    knownDivergence: {
      reason:
        'Caught by this differential on its first working run: our scrollUntilVisible times out finding home-open-form where Maestro 2.5.1 scrolls to it and passes. The flow cannot reach its tapOn step, so bug class 4 has no working device detector until that engine bug is fixed. Declared rather than chased inline — the instrument does not block on repairing what it just measured.',
      tracking: 'https://github.com/callstack/agent-device/issues/1299',
      // Exactly what runs 29504440599 and 29510020718 observed. If upstream
      // starts failing too, or the flow fails for a different reason, the
      // signature stops matching and the job goes red — a waiver for THIS bug
      // must not silently cover the next one.
      expected: {
        maestro: 'pass',
        agentDevice: 'fail',
        // The tap step is never reached, so the settle invariant has no data.
        invariants: ['no-data'],
      },
    },
  },
  {
    id: 'percent-swipe',
    // Deliberately NOT tagged bugClass 1. Truncation-vs-rounding is at most a
    // one-pixel difference: no app-observable outcome on a real device can
    // distinguish it, so claiming this scenario guards bug class 1 would be a
    // lie the pass/pass result cannot back up. That half is pinned exactly by a
    // pure unit test of the conversion
    // (src/compat/maestro/__tests__/runtime-port-geometry.test.ts), and the
    // parse-level half by layer 1 (bug-classes/percent-decimal-swipe). What this
    // scenario adds is only that percentage swipes work end-to-end on both.
    flow: 'differential/flows/percent-swipe.yaml',
    comparesAcrossEngines:
      'A percentage-endpoint swipe completes on both engines. It does NOT compare resolved pixel endpoints — no metric records them and a 1px delta is not app-observable.',
    expect: 'pass',
    engineInvariants: [
      {
        kind: 'gestureExecutionProfile',
        command: 'swipe',
        profile: 'endpoint-hold',
        because:
          'Maestro timed swipes are normalized to pan with the endpoint-hold execution profile, which the iOS runner delivers as a fast 100ms move followed by a hold.',
      },
    ],
    divergenceMeans: 'The swipe behaves differently enough on one engine to fail the flow.',
  },
  {
    id: 'tap-retry-if-no-change',
    flow: 'differential/flows/tap-retry-if-no-change.yaml',
    comparesAcrossEngines: 'A tap on an inert target completes on both engines.',
    expect: 'pass',
    // The whole point of the scenario. Outcome parity cannot see a retry: a tap
    // that never re-taps passes just the same, which is how this scenario spent
    // its first two runs proving nothing (#1300). The flow taps a surface that
    // provably cannot change, so the retry MUST fire; if it does not, either the
    // retry path regressed or the fixture stopped being inert, and both are
    // things we want to hear about.
    engineInvariants: [
      {
        kind: 'metricAtLeast',
        command: 'tapOn',
        metric: 'tapRetries',
        min: 1,
        because:
          'a tap on an unchanging screen must re-tap; zero retries means retryIfNoChange never ran and the scenario proved nothing',
      },
    ],
    divergenceMeans:
      'agent-device stopped re-tapping when the screen holds still (a retryIfNoChange regression), or the fixture surface it taps is no longer inert.',
  },
  {
    id: 'optional-warned-not-failed',
    flow: 'differential/flows/optional-warned-not-failed.yaml',
    comparesAcrossEngines:
      'An optional assertion on an element that never exists is downgraded to a warning and the flow still completes on both engines — a failed-instead-of-warned classification flips the exit code, so outcome parity does prove this one.',
    expect: 'pass',
    divergenceMeans: 'agent-device failed an optional command upstream would have warned on.',
  },
  {
    id: 'wait-animation-between-taps',
    flow: 'differential/flows/wait-animation-between-taps.yaml',
    comparesAcrossEngines:
      'Tapping two tabs with waitForAnimationToEnd between them completes on both engines.',
    expect: 'pass',
    divergenceMeans:
      'agent-device fails the tap/wait/tap sequence with a stability-generation mismatch where upstream passes.',
  },
];
