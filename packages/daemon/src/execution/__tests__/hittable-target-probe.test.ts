import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { IOS_SIMULATOR } from '@agent-device/test-kit';
import type {
  QuerySelectorInput,
  QuerySelectorResult,
} from '@agent-device/contracts/selector-observation-runtime';
import type { SessionState } from '../../core/session-state.ts';
import { classifyHittabilityReading, probeIosTargetHittability } from '../hittable-target-probe.ts';

const TARGET = { x: 294, y: 425.66, width: 88, height: 82 };

function makeSession(): SessionState {
  return { name: 'default', device: IOS_SIMULATOR, createdAt: Date.now(), actions: [] };
}

type ProbeQuery = (input: QuerySelectorInput) => Promise<QuerySelectorResult>;

function probeWith(querySelector: ProbeQuery, node: { identifier?: string; label?: string }) {
  return probeIosTargetHittability({
    session: makeSession(),
    node: { ...node, rect: TARGET },
    querySelector,
    execution: {},
  });
}

test('classifyHittabilityReading: a single match on the target frame speaks for it', () => {
  assert.equal(
    classifyHittabilityReading({ matchCount: 1, hittable: false, rect: TARGET }, TARGET),
    'notHittable',
  );
  assert.equal(
    classifyHittabilityReading({ matchCount: 1, hittable: true, rect: TARGET }, TARGET),
    'hittable',
  );
});

test('classifyHittabilityReading: a frame that is not the target frame is unknown', () => {
  const elsewhere = { ...TARGET, y: TARGET.y + 100 };

  assert.equal(
    classifyHittabilityReading({ matchCount: 1, hittable: false, rect: elsewhere }, TARGET),
    'unknown',
  );
});

test('classifyHittabilityReading: an ambiguous or missing match is unknown', () => {
  assert.equal(classifyHittabilityReading({ matchCount: 2 }, TARGET), 'unknown');
  assert.equal(classifyHittabilityReading({ matchCount: 0 }, TARGET), 'unknown');
  assert.equal(classifyHittabilityReading(undefined, TARGET), 'unknown');
  assert.equal(
    classifyHittabilityReading({ matchCount: 1, hittable: false }, TARGET),
    'unknown',
    'a single match with no frame cannot be tied to the target',
  );
});

test('probeIosTargetHittability: asks the lean probe with the derived selector and app scope', async () => {
  const querySelector = vi.fn<ProbeQuery>(async () => ({
    found: true,
    hittability: { matchCount: 1, hittable: false, rect: TARGET },
  }));

  const verdict = await probeIosTargetHittability({
    session: { ...makeSession(), appBundleId: 'com.example.demo' },
    node: { label: 'Delete Avocado', rect: TARGET },
    querySelector,
    execution: { requestId: 'req-1' },
  });

  assert.equal(verdict, 'notHittable');
  assert.deepEqual(querySelector.mock.calls[0]?.[0], {
    selector: { key: 'label', value: 'Delete Avocado' },
    probe: 'hittability',
    options: { appBundleId: 'com.example.demo' },
    execution: { requestId: 'req-1' },
  });
});

test('probeIosTargetHittability: hands the admission read signal to the native read', async () => {
  const signal = new AbortController().signal;
  const querySelector = vi.fn<ProbeQuery>(async () => ({ found: false }));

  await probeIosTargetHittability({
    session: makeSession(),
    node: { label: 'Delete Avocado', rect: TARGET },
    querySelector,
    execution: {},
    signal,
  });

  assert.equal(querySelector.mock.calls[0]?.[0].signal, signal);
});

test('probeIosTargetHittability: a node with no label or identifier is unknown without a read', async () => {
  const querySelector = vi.fn<ProbeQuery>();

  assert.equal(await probeWith(querySelector, {}), 'unknown');
  assert.equal(querySelector.mock.calls.length, 0);
});

test('probeIosTargetHittability: a failed read is unknown', async () => {
  const verdict = await probeWith(
    async () => {
      throw new AppError('COMMAND_FAILED', 'runner unavailable');
    },
    { label: 'Delete Avocado' },
  );

  assert.equal(verdict, 'unknown');
});
