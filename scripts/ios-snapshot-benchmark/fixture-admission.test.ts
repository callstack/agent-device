import assert from 'node:assert/strict';
import { test } from 'vitest';
import { BenchmarkCellAdmissionError } from './lifecycle.ts';
import {
  prepareFixture,
  requireFixtureAnchor,
  type FixturePreparationDriver,
  type FixturePreparationResult,
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

function observed(anchor: string): FixturePreparationResult {
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
    () => prepareFixture(alertFixture, successfulDriver(['Automation lab', 'Settings'])),
    (error: unknown) =>
      error instanceof BenchmarkCellAdmissionError && error.reason === 'fixture-anchor',
  );
});

test('checks the expected post-setup anchor for direct client batch results', () => {
  assert.throws(
    () => requireFixtureAnchor(observed('Settings').payload, alertFixture, 'prepared'),
    (error: unknown) =>
      error instanceof BenchmarkCellAdmissionError && error.reason === 'fixture-anchor',
  );
});
