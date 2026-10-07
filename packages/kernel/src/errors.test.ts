import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  AppError,
  defaultHintForCode,
  discloseDispatch,
  discloseDispatchAfterSteps,
  normalizeError,
  PRE_DISPATCH_REFUSAL_REASONS,
  sessionAppRequiredDetails,
  sessionOrDeviceSelectorRequiredDetails,
  throwDaemonError,
  readElementMatchCandidateRefs,
  readErrorCandidateViews,
  summarizeCommandAttemptFailures,
} from './errors.ts';

test('the pre-dispatch refusal reasons are the values consumers branch on', () => {
  assert.deepEqual(PRE_DISPATCH_REFUSAL_REASONS, {
    sessionAppRequired: 'session_app_required',
    sessionOrDeviceSelectorRequired: 'session_or_device_selector_required',
  });
});

for (const [label, details, code, message] of [
  [
    'sessionAppRequired',
    sessionAppRequiredDetails(),
    'INVALID_ARGS',
    'permission setting requires an active app in session',
  ],
  [
    'sessionOrDeviceSelectorRequired',
    sessionOrDeviceSelectorRequiredDetails(),
    'INVALID_ARGS',
    'clipboard requires an active session or an explicit device selector (e.g. --platform ios).',
  ],
] as const) {
  test(`${label} refusal carries its reason and dispatched:no through normalize and the wire`, () => {
    const normalized = normalizeError(new AppError(code, message, details));
    assert.equal(normalized.message, message);
    assert.equal(normalized.details?.reason, details.reason);
    assert.equal(normalized.details?.dispatched, 'no');
    assert.throws(
      () => throwDaemonError(normalized),
      (error: unknown) =>
        error instanceof AppError &&
        error.details?.reason === details.reason &&
        error.details?.dispatched === 'no',
    );
  });

  test(`${label} reason survives a second normalization of the wire shape`, () => {
    const once = normalizeError(new AppError(code, message, details));
    const twice = normalizeError(new AppError(once.code, once.message, once.details));
    assert.deepEqual(twice.details, once.details);
  });
}

test('a published refusal keeps the INVALID_ARGS default hint — the reason carries the extra fact', () => {
  for (const details of [sessionAppRequiredDetails(), sessionOrDeviceSelectorRequiredDetails()]) {
    const normalized = normalizeError(new AppError('INVALID_ARGS', 'refused', details));
    assert.equal(normalized.hint, defaultHintForCode('INVALID_ARGS'));
  }
});

test('a sibling INVALID_ARGS refusal without a reason cannot activate a reason-driven consumer', () => {
  const unrelated = normalizeError(
    new AppError('INVALID_ARGS', 'clipboard requires a subcommand: read or write'),
  );
  assert.equal(unrelated.details?.reason, undefined);
  assert.equal('dispatched' in (unrelated.details ?? {}), false);
});

test('normalizeError retains redacted nested command errors through repeated normalization', () => {
  const stderr = `Launch request denied\n${'Context line\n'.repeat(50)}Underlying reason: token=private-value device locked`;
  const expected = stderr.replace('private-value', '[REDACTED]');
  const first = normalizeError(new AppError('COMMAND_FAILED', 'Launch failed', { stderr }));
  const second = normalizeError(new AppError(first.code, first.message, first.details));
  assert.equal(first.details?.stderr, expected);
  assert.equal(second.details?.stderr, expected);
});

test('readElementMatchCandidateRefs extracts refs from candidate lines', () => {
  assert.deepEqual(
    readElementMatchCandidateRefs({
      candidates: ['@e2 [button] "Follow"', '@e5~s42 [button] "Follow"', 'not a ref'],
    }),
    ['e2', 'e5'],
  );
});

test('readElementMatchCandidateRefs ignores non-string candidate details', () => {
  assert.deepEqual(readElementMatchCandidateRefs({ candidates: [{ ref: 'e2' }, 4] }), []);
  assert.deepEqual(readElementMatchCandidateRefs(undefined), []);
});

test('readErrorCandidateViews projects element matches and generation', () => {
  assert.deepEqual(
    readErrorCandidateViews({
      matches: 7,
      candidates: ['@e2 [button] "Row"'],
      refsGeneration: 42,
    }),
    [
      {
        kind: 'element-match',
        matches: 7,
        candidates: ['@e2 [button] "Row"'],
        refsGeneration: 42,
      },
    ],
  );
});

test('readErrorCandidateViews projects devices and rejects object candidates', () => {
  assert.deepEqual(
    readErrorCandidateViews({
      candidates: [{ id: 'SIM-001', name: 'iPhone 17 Pro' }],
      devices: [{ id: 'SIM-001', name: 'iPhone 17 Pro' }],
    }),
    [{ kind: 'device', devices: [{ id: 'SIM-001', name: 'iPhone 17 Pro' }] }],
  );
});

test("summarizeCommandAttemptFailures joins argv and caps each attempt's stderr", () => {
  const [summary] = summarizeCommandAttemptFailures([
    { args: ['shell', 'cmd', 'fingerprint'], stdout: 'out', stderr: 'x'.repeat(500), exitCode: 2 },
  ]);

  assert.deepEqual(summary, {
    args: 'shell cmd fingerprint',
    exitCode: 2,
    // 400 is the per-attempt budget the settings retry loops have always shipped evidence under;
    // it is pinned as a literal so a changed budget cannot move both the producer and this oracle.
    stderr: 'x'.repeat(400),
  });
});

test('summarizeCommandAttemptFailures keeps every attempt in the order it ran', () => {
  assert.deepEqual(
    summarizeCommandAttemptFailures([
      { args: ['first'], stdout: '', stderr: 'a', exitCode: 1 },
      { args: ['second'], stdout: '', stderr: 'b', exitCode: 9 },
    ]).map(({ args, exitCode }) => `${args}:${exitCode}`),
    ['first:1', 'second:9'],
  );
});

test('normalizeError keeps a producer dispatch disclosure in details and never invents one', () => {
  for (const dispatched of ['no', 'unknown'] as const) {
    const normalized = normalizeError(new AppError('COMMAND_FAILED', 'tap failed', { dispatched }));
    assert.equal(normalized.details?.dispatched, dispatched);
    assert.throws(
      () => throwDaemonError(normalized),
      (error: unknown) => error instanceof AppError && error.details?.dispatched === dispatched,
    );
  }
  const unclassified = normalizeError(new AppError('COMMAND_FAILED', 'tap failed', { x: 1 }));
  assert.equal(unclassified.details?.dispatched, undefined);
  assert.equal('dispatched' in (unclassified.details ?? {}), false);
  assert.equal(normalizeError(new AppError('DEVICE_IN_USE', 'busy')).details, undefined);
});

test('discloseDispatchAfterSteps keeps no only while no step of the series was dispatched', () => {
  const refusal = () => discloseDispatch(new AppError('COMMAND_FAILED', 'busy'), 'no');
  assert.equal((discloseDispatchAfterSteps(refusal(), 0) as AppError).details?.dispatched, 'no');
  const later = discloseDispatchAfterSteps(refusal(), 2) as AppError;
  assert.equal(later.details?.dispatched, 'unknown');
  assert.equal(later.details?.dispatchedSteps, 2);
  const nested = discloseDispatchAfterSteps(
    discloseDispatch(new AppError('COMMAND_FAILED', 'chunk 3 lost'), 'unknown', {
      dispatchedSteps: 2,
    }),
    1,
  ) as AppError;
  assert.equal(nested.details?.dispatchedSteps, 3);
  const plain = new Error('socket closed');
  assert.equal(discloseDispatchAfterSteps(plain, 4), plain);
});

test('bundled plugin errors preserve codes and details without changing subclass checks', async () => {
  const copyPath = './errors.ts?plugin-copy';
  const { AppError: PluginError } = await import(copyPath);
  assert.notEqual(PluginError, AppError);
  const foreign = new PluginError('INVALID_ARGS', 'bad plugin profile', { provider: 'example' });
  assert.ok(foreign instanceof AppError);
  const normalized = normalizeError(foreign);
  assert.equal(normalized.code, 'INVALID_ARGS');
  assert.equal(normalized.message, 'bad plugin profile');
  assert.deepEqual(normalized.details, { provider: 'example' });
  const ordinary = Object.assign(new Error('bad plugin profile'), { code: 'INVALID_ARGS' });
  assert.equal(ordinary instanceof AppError, false);
  class SpecificError extends AppError {}
  assert.ok(new SpecificError('COMMAND_FAILED', 'specific') instanceof SpecificError);
  assert.equal(foreign instanceof SpecificError, false);
});
