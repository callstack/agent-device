import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { inspectAdReplay } from '../inspect.ts';

const SCRIPT = 'context platform=ios\nopen "Demo"\nclick label="Save"\n';

test('inspectAdReplay parses script text into actions, a line table and header metadata', () => {
  const manifest = inspectAdReplay(SCRIPT);

  assert.deepEqual(
    manifest.actions.map((action) => action.command),
    ['open', 'click'],
  );
  assert.deepEqual(manifest.actionLines, [2, 3]);
  assert.equal(manifest.metadata.platform, 'ios');
});

/**
 * ADR 0012's `--from`/`--plan-digest` resume quotes a digest back from a divergence report, so the
 * digest for a given script must not move. #1802 changed only HOW the script reaches the daemon
 * (a replay script source bundle instead of a path it opened itself); the digest is computed over
 * the same text and stays byte-identical, which is what keeps a resume issued before the change
 * valid after it.
 */
test('inspectAdReplay pins the plan digest for a known script', () => {
  assert.equal(
    inspectAdReplay(SCRIPT).planDigest,
    inspectAdReplay(SCRIPT, { platform: 'ios' }).planDigest,
  );
  assert.equal(
    inspectAdReplay(SCRIPT).planDigest,
    '0641236777b11822d90d446022965629ec99ac2ba1af2d5c637f06dd684fe695',
  );
});

test('inspectAdReplay rejects a legacy JSON replay payload', () => {
  assert.throws(
    () => inspectAdReplay('[{"command":"open"}]'),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message.includes('JSON replay payloads are no longer supported'),
  );
});
