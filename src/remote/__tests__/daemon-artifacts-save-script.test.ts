/**
 * #1802, the write half of the caller/daemon file split.
 *
 * Reading was fixed by sending script sources with the request. Writing has no symmetric path:
 * `--save-script` publishes a healed `.ad` through the daemon's own `SessionScriptWriter`, at
 * session teardown, on the daemon's disk — next to a source path that does not exist there. A
 * remote request that would produce a file the caller can never see is refused here instead of
 * appearing to succeed.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { prepareRemoteRequestArtifacts } from '../daemon-artifacts.ts';

const REMOTE = { baseUrl: 'http://remote-mac.example.test:7777/agent-device', token: 'secret' };
const LOCAL = { token: 'secret' };

function replayRequest(saveScript?: boolean | string) {
  return {
    session: 'default',
    command: 'replay',
    positionals: ['./flows/login.ad'],
    flags: { ...(saveScript === undefined ? {} : { saveScript }) },
    meta: { cwd: '/repo' },
  };
}

test('a remote daemon refuses --save-script, naming the caller/daemon split', async () => {
  await assert.rejects(
    async () => await prepareRemoteRequestArtifacts(replayRequest(true), REMOTE),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message.includes('written on the daemon host'),
  );
});

test('a remote daemon refuses an explicit --save-script output path too', async () => {
  await assert.rejects(
    async () =>
      await prepareRemoteRequestArtifacts(replayRequest('./flows/login.healed.ad'), REMOTE),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
});

test('a local daemon leaves --save-script untouched', async () => {
  const prepared = await prepareRemoteRequestArtifacts(replayRequest(true), LOCAL);

  assert.equal(prepared.flags?.saveScript, true);
  assert.deepEqual(prepared.positionals, ['./flows/login.ad']);
});

test('a remote replay without --save-script passes through unchanged', async () => {
  const prepared = await prepareRemoteRequestArtifacts(replayRequest(), REMOTE);

  assert.deepEqual(prepared.positionals, ['./flows/login.ad']);
  assert.equal(prepared.uploadedArtifactId, undefined);
});
