import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, vi } from 'vitest';
import { runCmdBackground } from '@agent-device/host-kit/command';
import { simulatorAddressFor } from '../core/simctl.ts';
import { createSnapshotSourceHost, snapshotSourceSocketPath } from './host.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdBackground: vi.fn(),
}));

test('snapshot bridge socket paths stay within the AF_UNIX limit and are target-specific', () => {
  const host = createSnapshotSourceHost();
  const first = snapshotSourceSocketPath(host, 'simulator-1', 'owner-1');
  const second = snapshotSourceSocketPath(host, 'simulator-2', 'owner-1');
  const otherOwner = snapshotSourceSocketPath(host, 'simulator-1', 'owner-2');

  assert.equal(first.length < 104, true);
  assert.equal(second.length < 104, true);
  assert.equal(otherOwner.length < 104, true);
  assert.notEqual(first, second);
  assert.notEqual(first, otherOwner);
});

test.each([
  ['the default simulator set', undefined, []],
  ['a scoped simulator set', '/tmp/scoped-set', ['--set', '/tmp/scoped-set']],
] as const)('the bridge spawns inside %s', (_label, simulatorSetPath, setArgs) => {
  const spawn = vi.mocked(runCmdBackground);
  spawn.mockReset();
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    stderr: null,
  });
  spawn.mockReturnValue({
    child: child as unknown as ReturnType<typeof runCmdBackground>['child'],
    wait: new Promise(() => {}),
  });

  const started = createSnapshotSourceHost().start(
    simulatorAddressFor({
      platform: 'apple',
      id: 'simulator-1',
      name: 'iPhone 17',
      kind: 'simulator',
      target: 'mobile',
      ...(simulatorSetPath ? { simulatorSetPath } : {}),
    }),
    '/tmp/bridge',
    '/tmp/bridge.sock',
  );

  assert.equal(started.pid, 4242);
  assert.deepEqual(spawn.mock.calls[0]?.slice(0, 2), [
    'xcrun',
    [
      'simctl',
      ...setArgs,
      'spawn',
      'simulator-1',
      '/tmp/bridge',
      'serve',
      '/tmp/bridge.sock',
      '--idle-timeout',
      '60',
      '--exit-on-disconnect',
      'false',
    ],
  ]);
});
