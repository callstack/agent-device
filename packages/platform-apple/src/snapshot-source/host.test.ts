import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import { runCmdBackground, withCommandHost } from '@agent-device/host-kit/command';
import {
  bindTestCommandHost,
  createLiveTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { simulatorAddressFor } from '../core/simctl.ts';
import { createSnapshotSourceHost, snapshotSourceSocketPath } from './host.ts';

bindTestCommandHost();

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdBackground: vi.fn(),
}));

test('snapshot bridge socket paths stay within the AF_UNIX limit and are target-specific', () => {
  const host = createSnapshotSourceHost(createLiveTestHostEnvironment());
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

  const started = createSnapshotSourceHost(createLiveTestHostEnvironment()).start(
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

test('the detached bridge starts in the host directory, not the process directory', async () => {
  const root = mkdtempForTestSync('snapshot-bridge-cwd-');
  const bin = path.join(root, 'bin');
  const hostCwd = path.join(root, 'host-cwd');
  const evidence = path.join(root, 'evidence.txt');
  fs.mkdirSync(bin);
  fs.mkdirSync(hostCwd);
  fs.writeFileSync(path.join(bin, 'xcrun'), '#!/bin/sh\nprintf "%s\\n" "$PWD" > "$EVIDENCE"\n', {
    mode: 0o755,
  });
  const actual = await vi.importActual<typeof import('@agent-device/host-kit/command')>(
    '@agent-device/host-kit/command',
  );
  vi.mocked(runCmdBackground).mockReset().mockImplementation(actual.runCmdBackground);

  await withCommandHost(
    { host: { env: { PATH: bin, EVIDENCE: evidence }, cwd: hostCwd }, requestEnv: undefined },
    async () => {
      createSnapshotSourceHost({ env: { PATH: bin, EVIDENCE: evidence }, cwd: hostCwd }).start(
        simulatorAddressFor({
          platform: 'apple',
          id: 'simulator-1',
          name: 'iPhone 17',
          kind: 'simulator',
          target: 'mobile',
        }),
        '/tmp/bridge',
        '/tmp/bridge.sock',
      );
    },
  );

  await vi.waitFor(() =>
    assert.equal(fs.readFileSync(evidence, 'utf8'), `${fs.realpathSync(hostCwd)}\n`),
  );
});
