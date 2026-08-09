import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildAppleLogPredicate,
  buildIosDeviceConsoleLaunchArgs,
  buildIosSimulatorLogStreamArgs,
} from './log-predicate.ts';

test('Apple app-log predicate covers bundle and executable provenance', () => {
  const predicate = buildAppleLogPredicate('com.example."quoted"', 'ExampleExec');

  assert.match(predicate, /subsystem == "com\.example\.\\"quoted\\""/);
  assert.match(predicate, /subsystem CONTAINS "com\.example\.\\"quoted\\""/);
  assert.match(predicate, /process == "ExampleExec"/);
  assert.match(predicate, /processImagePath CONTAINS\[c\] "\/ExampleExec\.app\/"/);
  assert.doesNotMatch(predicate, /eventMessage/);
});

test('Apple app-log arguments preserve simulator-set and CoreDevice launch semantics', () => {
  assert.deepEqual(
    buildIosSimulatorLogStreamArgs({
      deviceId: 'sim-1',
      appBundleId: 'com.example.app',
      executableName: 'ExampleExec',
      simulatorSetPath: '/tmp/tenant-a/simulators',
    }),
    [
      'simctl',
      '--set',
      '/tmp/tenant-a/simulators',
      'spawn',
      'sim-1',
      'log',
      'stream',
      '--style',
      'compact',
      '--level',
      'info',
      '--predicate',
      buildAppleLogPredicate('com.example.app', 'ExampleExec'),
    ],
  );
  assert.deepEqual(buildIosDeviceConsoleLaunchArgs('physical-1', 'com.example.app'), [
    'devicectl',
    'device',
    'process',
    'launch',
    '--device',
    'physical-1',
    '--console',
    '--terminate-existing',
    'com.example.app',
  ]);
});
