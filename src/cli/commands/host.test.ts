import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { createTestClient } from '../../__tests__/remote-connection.fixtures.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { hostCommand } from './host.ts';

function startHost(stateDir: string, extraFlags: Record<string, string> = {}) {
  return hostCommand({
    positionals: [],
    flags: { json: true, help: false, version: false, stateDir, ...extraFlags },
    client: createTestClient(),
  });
}

async function refusalReason(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    return error.details?.reason;
  }
  assert.fail('expected host to refuse to start');
}

test('a malformed credential stops host before any daemon starts', async () => {
  const stateDir = mkdtempForTestSync('agent-device-host-start-');
  const hostDir = path.join(stateDir, 'host');
  fs.mkdirSync(hostDir, { mode: 0o700 });
  fs.writeFileSync(path.join(hostDir, 'service-credential.json'), '{}\n', { mode: 0o600 });

  assert.equal(await refusalReason(startHost(stateDir)), 'host-credential-invalid');
  assert.equal(fs.existsSync(path.join(stateDir, 'daemon.json')), false);
});

test('an unreadable TLS file is a typed refusal before any daemon starts', async () => {
  const stateDir = mkdtempForTestSync('agent-device-host-start-');

  const reason = await refusalReason(
    startHost(stateDir, {
      hostTlsCert: path.join(stateDir, 'missing-cert.pem'),
      hostTlsKey: path.join(stateDir, 'missing-key.pem'),
    }),
  );

  assert.equal(reason, 'host-tls-unreadable');
  assert.equal(fs.existsSync(path.join(stateDir, 'daemon.json')), false);
});
