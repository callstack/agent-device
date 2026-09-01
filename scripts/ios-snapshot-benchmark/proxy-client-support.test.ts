import assert from 'node:assert/strict';
import { test } from 'vitest';
import { BenchmarkCellAdmissionError } from './lifecycle.ts';
import { openClientFixture, type AgentClient } from './proxy-client-support.ts';
import type { ScreenFixture } from './types.ts';

const alertFixture: ScreenFixture = {
  id: 'alert',
  label: 'Native alert',
  app: 'com.callstack.agentdevicelab',
  anchorText: 'Automation lab',
  postSetupAnchorText: 'Automation confirmation',
  setupAction: 'open-alert',
};

function clientWithSnapshots(anchors: string[], calls: string[]): AgentClient {
  return {
    apps: {
      open: async () => {
        calls.push('open');
        return {};
      },
    },
    interactions: {
      scroll: async () => {
        calls.push('scroll');
        return {};
      },
      click: async () => {
        calls.push('click');
        return {};
      },
    },
    batch: {
      run: async () => {
        calls.push('snapshot');
        return {
          results: [
            {
              step: 1,
              command: 'snapshot',
              ok: true,
              data: { snapshot: { nodes: [{ label: anchors.shift() ?? '' }] } },
              durationMs: 1,
            },
          ],
          total: 1,
          executed: 1,
          totalDurationMs: 1,
        };
      },
    },
    sessions: { close: async () => ({}) },
    leases: {
      allocate: async () => ({}),
      release: async () => ({}),
    },
  };
}

test('persistent-client fixture setup admits both opened and prepared anchors', async () => {
  const calls: string[] = [];
  await openClientFixture(
    clientWithSnapshots(['Automation lab', 'Automation confirmation'], calls),
    alertFixture,
    'simulator',
  );
  assert.deepEqual(calls, ['open', 'snapshot', 'scroll', 'click', 'snapshot']);
});

test('persistent-client setup rejects a wrong prepared screen as fixture-anchor', async () => {
  await assert.rejects(
    () =>
      openClientFixture(
        clientWithSnapshots(['Automation lab', 'Settings'], []),
        alertFixture,
        'simulator',
      ),
    (error: unknown) =>
      error instanceof BenchmarkCellAdmissionError && error.reason === 'fixture-anchor',
  );
});
