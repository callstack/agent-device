import assert from 'node:assert/strict';
import { test } from 'vitest';
import { BenchmarkCellAdmissionError } from './lifecycle.ts';
import {
  prepareFixture,
  requireFixtureAnchor,
  type FixtureOperationResult,
  type FixturePreparationDriver,
} from './fixture-admission.ts';
import type { ScreenFixture } from './types.ts';

const alertFixture: ScreenFixture = {
  id: 'alert',
  label: 'Native alert',
  app: 'com.callstack.agentdevicelab',
  anchorText: 'Automation lab',
  postSetupAnchorText: 'Automation confirmation',
  setupAction: 'open-alert',
};

const shortAnchorOptions = { anchorBudgetMs: 40, anchorPollMs: 5 };

function observed(anchor: string): FixtureOperationResult {
  return {
    ok: true,
    payload: {
      total: 1,
      results: [{ data: { snapshot: { nodes: [{ label: anchor }] } } }],
    },
  };
}

function successfulDriver(observations: string[]): FixturePreparationDriver {
  const calls: FixturePreparationDriver = {
    observe: () => observed(observations.shift() ?? ''),
    scrollToBottom: () => ({ ok: true, payload: {} }),
    openAlert: () => ({ ok: true, payload: {} }),
  };
  return calls;
}

test('shares opening, setup, and post-setup admission across fixture drivers', async () => {
  const calls: string[] = [];
  const driver: FixturePreparationDriver = {
    observe: () => {
      calls.push('observe');
      return observed(calls.length === 1 ? 'Automation lab' : 'Automation confirmation');
    },
    scrollToBottom: () => {
      calls.push('scroll');
      return { ok: true, payload: {} };
    },
    openAlert: () => {
      calls.push('open-alert');
      return { ok: true, payload: {} };
    },
  };

  await prepareFixture(alertFixture, driver);

  assert.deepEqual(calls, ['observe', 'scroll', 'open-alert', 'observe']);
});

test('turns a wrong post-setup screen into a typed fixture-anchor stop', async () => {
  await assert.rejects(
    () =>
      prepareFixture(
        alertFixture,
        successfulDriver(['Automation lab', 'Settings']),
        shortAnchorOptions,
      ),
    (error: unknown) =>
      error instanceof BenchmarkCellAdmissionError &&
      error.reason === 'fixture-anchor' &&
      error.message.includes('within 40ms'),
  );
});

test('waits an unmounted opening screen out, then continues setup', async () => {
  const calls: string[] = [];
  const anchors = ['Settings', 'Settings', 'Automation lab', 'Automation confirmation'];
  const driver: FixturePreparationDriver = {
    observe: () => {
      calls.push('observe');
      return observed(anchors.shift() ?? 'Unexpected extra observation');
    },
    scrollToBottom: () => {
      calls.push('scroll');
      return { ok: true, payload: {} };
    },
    openAlert: () => {
      calls.push('open-alert');
      return { ok: true, payload: {} };
    },
  };

  await prepareFixture(alertFixture, driver, shortAnchorOptions);

  assert.deepEqual(calls, ['observe', 'observe', 'observe', 'scroll', 'open-alert', 'observe']);
  assert.deepEqual(anchors, []);
});

test('stops at the opening anchor once the admission budget elapses', async () => {
  const unmounted: FixturePreparationDriver = {
    observe: () => observed('Settings'),
    scrollToBottom: () => ({ ok: true, payload: {} }),
    openAlert: () => ({ ok: true, payload: {} }),
  };
  const started = Date.now();
  await assert.rejects(
    () => prepareFixture(alertFixture, unmounted, shortAnchorOptions),
    (error: unknown) =>
      error instanceof BenchmarkCellAdmissionError &&
      error.reason === 'fixture-anchor' &&
      error.message.includes('within 40ms'),
  );
  assert.ok(Date.now() - started < 5_000, 'the anchor budget was not honored');
});

test('fails an unsuccessful observation immediately instead of polling', async () => {
  let observations = 0;
  const driver: FixturePreparationDriver = {
    observe: () => {
      observations += 1;
      return { ok: false, payload: {} };
    },
    scrollToBottom: () => ({ ok: true, payload: {} }),
    openAlert: () => ({ ok: true, payload: {} }),
  };

  await assert.rejects(
    () => prepareFixture(alertFixture, driver, { anchorBudgetMs: 5_000, anchorPollMs: 1 }),
    (error: unknown) =>
      error instanceof BenchmarkCellAdmissionError &&
      error.reason === 'fixture-anchor' &&
      error.message.includes('failed'),
  );
  assert.equal(observations, 1);
});

test('checks the expected post-setup anchor for direct client batch results', () => {
  assert.throws(
    () => requireFixtureAnchor(observed('Settings').payload, alertFixture, 'prepared'),
    (error: unknown) =>
      error instanceof BenchmarkCellAdmissionError && error.reason === 'fixture-anchor',
  );
});
