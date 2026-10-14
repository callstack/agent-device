import { beforeEach, expect, test, vi } from 'vitest';
import { IOS_SIMULATOR } from '@agent-device/test-kit/device-fixtures';
import { makeIosSession } from '../../__tests__/support/session-factories.ts';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { selectorCaptureFixture } from '../../__tests__/support/selector-capture-fixture.ts';
import { resolveSettleObservationCapture } from '../settle-observation-capture.ts';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';

vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>();
  return { ...actual, emitDiagnostic: vi.fn(actual.emitDiagnostic) };
});

// #3510: the capture a `--settle` observation polls on a route whose action runtime use carries
// none. The guarantee it owes is producer identity with the command the caller runs next; the one it
// must not break is that settling never fails the action it follows. These pin which plan gets
// admitted, how often, and that every way an observation capture goes away degrades to no capture
// while disclosing its typed reason.

const unavailablePhase = ['settle_observation_capture_unavailable'];

/** Level included: a degrade the caller cannot see must not be info-only, which success drops. */
function disclosures(): { level: string | undefined; data: Record<string, unknown> }[] {
  return vi
    .mocked(emitDiagnostic)
    .mock.calls.flatMap(([event]) =>
      event.phase === unavailablePhase[0] && event.data
        ? [{ level: event.level, data: event.data }]
        : [],
    );
}

beforeEach(() => {
  vi.mocked(emitDiagnostic).mockClear();
});

test('an available plan inspects once and binds once for the whole observation', async () => {
  const fixture = selectorCaptureFixture();

  const capture = await resolveSettleObservationCapture({
    command: 'back',
    session: makeIosSession('settle', { appBundleId: 'com.example.app' }),
    inspectFacts: fixture.inspectFacts,
    platformServices: daemonPlatformServicesFixture(),
    bindDevice: fixture.bindDevice,
  });
  if (!capture) throw new Error('expected an admitted capture');

  expect(fixture.inspections).toEqual([IOS_SIMULATOR]);
  expect(fixture.binds).toEqual([IOS_SIMULATOR]);

  await capture({});
  await capture({});
  expect(fixture.binds).toEqual([IOS_SIMULATOR]);
  expect(fixture.captures).toHaveLength(2);
});

// One rule over the two plan cells: an owner that refuses the observation's plan keeps the loop on
// its own snapshot path, and the refusal is disclosed with the typed fact rather than passing as a
// silently unchanged observation. The first row is the Apple no-tracked-app cell, where the owner's
// own `snapshot` refuses for the same declared reason.
test.each([
  {
    plan: 'without-active-app',
    refusal: { withoutActiveApp: { available: false, reason: 'owner-capability-missing' } },
    session: () => makeIosSession('no-app'),
    operation: 'captureSnapshotWithoutActiveApp',
    reason: 'owner-capability-missing',
  },
  {
    plan: 'active-app',
    refusal: { capture: { available: false, reason: 'unsupported-platform-leaf' } },
    session: () => makeIosSession('settle', { appBundleId: 'com.example.app' }),
    operation: 'captureSnapshot',
    reason: 'unsupported-platform-leaf',
  },
] as const)(
  'a $plan plan the owner refuses binds nothing and discloses its reason',
  async ({ refusal, session, operation, reason }) => {
    const fixture = selectorCaptureFixture(refusal);

    const capture = await resolveSettleObservationCapture({
      command: 'back',
      session: session(),
      inspectFacts: fixture.inspectFacts,
      platformServices: daemonPlatformServicesFixture(),
      bindDevice: fixture.bindDevice,
    });

    expect(capture).toBeUndefined();
    expect(fixture.binds).toEqual([]);
    expect(disclosures()).toEqual([
      { level: 'warn', data: { command: 'back', outcome: 'refused', operation, reason } },
    ]);
  },
);

// The two ways the owner's own machinery can fail the observation after a valid plan. Both are
// best-effort by contract: the command the loop follows must still run, and each is disclosed at
// `warn` — an info-only record is dropped on the success path, and these cells answer `ok: true`.
test.each([
  // Apple's inspection reads the host's screen-recording state and re-throws on a cancelled probe.
  ['admission-probe-failed', Object.assign(new Error('probe cancelled'), { name: 'AbortError' })],
  ['bind-failed', Object.assign(new Error('gateway closed'), { name: 'AppError' })],
] as const)(
  'a %s costs the action nothing and discloses its own failure',
  async (outcome, failure) => {
    const fixture = selectorCaptureFixture();
    const failing =
      outcome === 'admission-probe-failed'
        ? {
            inspectFacts: async () => {
              throw failure;
            },
            bindDevice: fixture.bindDevice,
          }
        : {
            inspectFacts: fixture.inspectFacts,
            bindDevice: async () => {
              throw failure;
            },
          };

    const capture = await resolveSettleObservationCapture({
      command: 'back',
      session: makeIosSession('settle', { appBundleId: 'com.example.app' }),
      platformServices: daemonPlatformServicesFixture(),
      ...failing,
    });

    expect(capture).toBeUndefined();
    expect(fixture.binds).toEqual([]);
    expect(disclosures()).toEqual([
      { level: 'warn', data: { command: 'back', outcome, errorName: failure.name } },
    ]);
  },
);
