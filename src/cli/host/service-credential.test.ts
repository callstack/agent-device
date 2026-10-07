import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { loadOrCreateHostServiceCredential } from './service-credential.ts';

function hostDir(): string {
  return path.join(mkdtempForTestSync('agent-device-host-credential-'), 'host');
}

function refusalReason(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    return error.details?.reason;
  }
  assert.fail('expected the credential load to be refused');
}

test('first start creates a private credential mapped to a stable principal', () => {
  const dir = hostDir();
  const { credential, credentialFile, created } = loadOrCreateHostServiceCredential(dir);

  assert.equal(created, true);
  assert.equal(credentialFile, path.join(dir, 'service-credential.json'));
  assert.match(credential.token, /^[0-9a-f]{64}$/);
  assert.equal(credential.principal, `host-svc-${credential.credentialId}`);
  assert.equal(fs.statSync(credentialFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('a restart reuses the same credential instead of issuing a new token', () => {
  const dir = hostDir();
  const first = loadOrCreateHostServiceCredential(dir);
  const afterRestart = loadOrCreateHostServiceCredential(dir);

  assert.equal(afterRestart.created, false);
  assert.deepEqual(afterRestart.credential, first.credential);
});

test('a credential file readable by group or others refuses to start', () => {
  const dir = hostDir();
  const { credentialFile } = loadOrCreateHostServiceCredential(dir);
  fs.chmodSync(credentialFile, 0o644);

  assert.equal(
    refusalReason(() => loadOrCreateHostServiceCredential(dir)),
    'host-credential-insecure',
  );
});

test('a credential directory open to group or others refuses to start', () => {
  const dir = hostDir();
  loadOrCreateHostServiceCredential(dir);
  fs.chmodSync(dir, 0o755);

  assert.equal(
    refusalReason(() => loadOrCreateHostServiceCredential(dir)),
    'host-credential-insecure',
  );
});

test('a malformed credential file is refused and never regenerated', () => {
  const dir = hostDir();
  const { credentialFile } = loadOrCreateHostServiceCredential(dir);
  fs.writeFileSync(credentialFile, '{"version":1,"token":"short"}\n', { mode: 0o600 });

  assert.equal(
    refusalReason(() => loadOrCreateHostServiceCredential(dir)),
    'host-credential-invalid',
  );
  assert.equal(fs.readFileSync(credentialFile, 'utf8'), '{"version":1,"token":"short"}\n');
});
