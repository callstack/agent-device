import { expect, test } from 'vitest';
import { resolveAppleSimulatorRunnerDemand } from './runner-demand.ts';

test('an unknown plan keeps the speculative prewarm', () => {
  expect(resolveAppleSimulatorRunnerDemand(undefined)).toBe('possible');
});

test('a plan served entirely by simctl and the AX bridge needs no runner', () => {
  expect(
    resolveAppleSimulatorRunnerDemand({
      operations: [
        'captureSnapshot',
        'captureSnapshotWithoutActiveApp',
        'captureScreenshot',
        'findText',
        'findSelector',
        'closeApplication',
        'finalizeApplicationClose',
      ],
    }),
  ).toBe('none');
});

test.each([
  ['a touch', 'tapPoint'],
  ['a text read', 'readTextAtPoint'],
  ['custom actions', 'captureSnapshotWithCustomActions'],
  ['an alert', 'readAlert'],
  ['runner preparation', 'prepareAppleRunner'],
])('a plan containing %s requires the runner', (_name, operation) => {
  expect(resolveAppleSimulatorRunnerDemand({ operations: ['captureSnapshot', operation] })).toBe(
    'required',
  );
});

test('an operation the table does not know is never proven runner-free', () => {
  expect(resolveAppleSimulatorRunnerDemand({ operations: ['notARuntimeOperation'] })).toBe(
    'required',
  );
});
