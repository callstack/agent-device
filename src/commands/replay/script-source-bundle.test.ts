import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  loadReplayScriptSourceBundle,
  REPLAY_SCRIPT_SOURCE_BUNDLE_MAX_BYTES,
} from './script-source-bundle.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

// #1802: the caller reads every script file a replay run needs and sends the text. These pin the
// collection itself; that the daemon consumes only the result is pinned beside the replay handler.

test('a native .ad bundle carries the entry script resolved against the caller cwd', async () => {
  const root = mkdtempForTestSync('agent-device-bundle-native-');
  const script = 'open "Demo"\nclick "Save"\n';
  fs.writeFileSync(path.join(root, 'flow.ad'), script);

  const bundle = await loadReplayScriptSourceBundle({ inputPath: './flow.ad', cwd: root });

  expect(bundle.entry).toBe(path.join(root, 'flow.ad'));
  expect(bundle.files).toEqual({ [path.join(root, 'flow.ad')]: script });
});

test('a Maestro bundle carries the entry flow and its transitive runFlow includes', async () => {
  const root = mkdtempForTestSync('agent-device-bundle-maestro-');
  fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'flow.yaml'),
    'appId: demo\n---\n- runFlow: shared/login.yaml\n',
  );
  fs.writeFileSync(path.join(root, 'shared', 'login.yaml'), '---\n- runFlow: ../tail.yaml\n');
  fs.writeFileSync(path.join(root, 'tail.yaml'), '---\n- back\n');

  const bundle = await loadReplayScriptSourceBundle({
    inputPath: './flow.yaml',
    cwd: root,
    replayBackend: 'maestro',
  });

  expect(Object.keys(bundle.files).sort()).toEqual(
    [
      path.join(root, 'flow.yaml'),
      path.join(root, 'shared', 'login.yaml'),
      path.join(root, 'tail.yaml'),
    ].sort(),
  );
});

// The failure the reporter saw was an `ENOENT` for a path that exists on the caller. Reading on
// the caller turns it into a normal INVALID_ARGS that names the path as typed, before any daemon
// round-trip.
test('a missing entry script fails as INVALID_ARGS naming the path as typed', async () => {
  const root = mkdtempForTestSync('agent-device-bundle-missing-');

  await expect(
    loadReplayScriptSourceBundle({ inputPath: './flows/login.ad', cwd: root }),
  ).rejects.toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      message: 'replay script not found on this machine: ./flows/login.ad',
    }),
  );
});

test('an oversized bundle is refused with the limit named', async () => {
  const root = mkdtempForTestSync('agent-device-bundle-oversize-');
  fs.writeFileSync(
    path.join(root, 'flow.ad'),
    `open "Demo"\n${'#'.repeat(REPLAY_SCRIPT_SOURCE_BUNDLE_MAX_BYTES)}\n`,
  );

  await expect(loadReplayScriptSourceBundle({ inputPath: './flow.ad', cwd: root })).rejects.toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      message: expect.stringContaining(`over the ${REPLAY_SCRIPT_SOURCE_BUNDLE_MAX_BYTES}-byte`),
    }),
  );
});
