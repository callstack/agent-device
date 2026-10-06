import { test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { resolveSessionDir } from '../session-artifact-paths.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

test('resolveSessionDir keeps every session dir beneath the sessions dir', () => {
  const sessionsDir = path.join(
    mkdtempForTestSync('agent-device-tests'),
    'agent-device-tests',
    'sessions',
  );
  assert.equal(resolveSessionDir(sessionsDir, 'a/b:c d'), path.join(sessionsDir, 'a_b_c_d'));
  // `.` and `..` survive `safeSessionName` unchanged, so without an explicit
  // refusal `path.join` resolves them to the sessions dir itself and its parent
  // (the daemon state dir): a remote caller's `--session ..` would then land
  // app.log / runner.log / requests/*.ndjson outside the sessions tree.
  for (const name of ['.', '..', '']) {
    assert.throws(
      () => resolveSessionDir(sessionsDir, name),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        /session name/i.test(error.message),
      `expected resolveSessionDir(${JSON.stringify(name)}) to reject`,
    );
  }
});
