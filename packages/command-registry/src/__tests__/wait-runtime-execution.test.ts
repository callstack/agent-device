import { expect, test } from 'vitest';
import { waitSelectorCaptureRuntimePlanUses } from '@agent-device/contracts/platform-runtime-operations';
import { waitObservesDevice } from '@agent-device/contracts/wait-runtime-plan';
import { commandDescriptors } from '../registry.ts';

test('wait descriptor declares its complete runtime use with no capability bucket', () => {
  const wait = commandDescriptors.find(({ name }) => name === 'wait');

  expect(wait).not.toHaveProperty('capability');
  expect(wait).not.toHaveProperty('dispatch');
  expect(wait?.platformExecution).toEqual({
    kind: 'device-runtime',
    uses: waitSelectorCaptureRuntimePlanUses,
  });
  // wait binds the family plan; its measured reading rides that plan's preferred set.
  expect(waitSelectorCaptureRuntimePlanUses).toEqual([
    {
      required: ['captureSnapshot'],
      preferred: [],
      conditional: ['findText', 'findSelector'],
    },
    {
      required: ['captureSnapshot', 'captureSnapshotWithoutActiveApp'],
      preferred: [],
      conditional: ['findText', 'findSelector'],
    },
  ]);
});

test('only the duration shape reaches no device at all', () => {
  expect(waitObservesDevice('sleep')).toBe(false);
  for (const target of ['text', 'ref', 'selector', 'stable'] as const) {
    expect(waitObservesDevice(target)).toBe(true);
  }
});

// Native observations are correctness-bearing where owner facts advertise them. They cannot be
// preferred optimizations, while making them unconditionally required would reject owners whose
// complete semantic path is capture-backed.
test('wait declares native observations as fact-conditional operations, never optimizations', () => {
  for (const use of waitSelectorCaptureRuntimePlanUses) {
    expect(use.conditional).toContain('findText');
    expect(use.required).not.toContain('findText');
    expect(use.preferred).not.toContain('findText');
    expect(use.conditional).toContain('findSelector');
    expect(use.required).not.toContain('findSelector');
    expect(use.preferred).not.toContain('findSelector');
    expect(use.required).toContain('captureSnapshot');
  }
});
