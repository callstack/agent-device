import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionResourceOwnershipViolations } from './session-resource-ownership.ts';

function summaries(entries: readonly (readonly [string, string])[]): string[] {
  return sessionResourceOwnershipViolations(new Map(entries)).map(
    ({ file, message }) => `${file}: ${message}`,
  );
}

test('session resources are constructed only by their durable domain owners', () => {
  assert.deepEqual(
    summaries([
      [
        'src/daemon/handlers/planted.ts',
        `sessionStore.set(name, {
          ...session,
          appLog: log,
          appLogFailure: failure,
          audioProbe: audio,
          perfCapture: perf,
        });`,
      ],
      [
        'src/daemon/app-log-session-resource.ts',
        `sessionStore.set(name, { ...session, appLog: log, appLogFailure: undefined });`,
      ],
      [
        'packages/capture-kit/src/capture-admission/audio-probe-session-resource.ts',
        `sessionStore.set(name, { ...session, audioProbe: audio });`,
      ],
      [
        'packages/capture-kit/src/capture-admission/perf-capture-session-resource.ts',
        `sessionStore.set(name, { ...session, perfCapture: perf });`,
      ],
    ]),
    [
      'src/daemon/handlers/planted.ts: session appLog record constructed outside its owner',
      'src/daemon/handlers/planted.ts: session appLogFailure record constructed outside its owner',
      'src/daemon/handlers/planted.ts: session audioProbe record constructed outside its owner',
      'src/daemon/handlers/planted.ts: session perfCapture record constructed outside its owner',
    ],
  );
});

test('the capture-admission owners sit inside the scan, so a field planted there is caught too', () => {
  assert.deepEqual(
    summaries([
      [
        'packages/capture-kit/src/capture-admission/durable-capture-resource.ts',
        `sessionStore.set(name, { ...session, perfCapture: perf });`,
      ],
    ]),
    [
      'packages/capture-kit/src/capture-admission/durable-capture-resource.ts: session perfCapture record constructed outside its owner',
    ],
  );
});

test('teardown app-log discriminants are policy input rather than session construction', () => {
  assert.deepEqual(
    summaries([
      [
        'src/daemon/session-teardown.ts',
        `teardownSessionResources({ appLog: 'run' });
         teardownSessionResources({ appLog: 'already-settled' });`,
      ],
      ['src/daemon/handlers/planted.ts', `teardownSessionResources({ appLog: 'skip' });`],
    ]),
    ['src/daemon/handlers/planted.ts: session appLog record constructed outside its owner'],
  );
});
