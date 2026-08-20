import { expect, test } from 'vitest';
import {
  selectorCaptureRuntimePlanUses,
  waitObservesDevice,
} from '@agent-device/contracts/platform';
import { commandDescriptors } from '../registry.ts';

test('wait descriptor declares its complete runtime use with no capability bucket', () => {
  const wait = commandDescriptors.find(({ name }) => name === 'wait');

  expect(wait).not.toHaveProperty('capability');
  expect(wait).not.toHaveProperty('dispatch');
  expect(wait?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: selectorCaptureRuntimePlanUses,
  });
  // wait binds the family plan; its measured reading rides that plan's preferred set.
  expect(selectorCaptureRuntimePlanUses).toEqual([
    {
      required: ['captureSnapshot'],
      preferred: ['readTextAtPoint', 'findText', 'findSelector'],
    },
    {
      required: ['captureSnapshot', 'captureSnapshotWithoutActiveApp'],
      preferred: ['readTextAtPoint', 'findText', 'findSelector'],
    },
  ]);
});

test('only the duration shape reaches no device at all', () => {
  expect(waitObservesDevice('sleep')).toBe(false);
  for (const target of ['text', 'ref', 'selector', 'stable'] as const) {
    expect(waitObservesDevice(target)).toBe(true);
  }
});

// The measured fast path is declared, and declared as PREFERRED: `findText` must never appear in
// a required set, or an owner without a native reading would stop being able to run `wait` at all.
test('wait declares native observations as preferred operations on every plan, never required', () => {
  for (const use of selectorCaptureRuntimePlanUses) {
    expect(use.preferred).toContain('findText');
    expect(use.required).not.toContain('findText');
    expect(use.preferred).toContain('findSelector');
    expect(use.required).not.toContain('findSelector');
    expect(use.required).toContain('captureSnapshot');
  }
});
