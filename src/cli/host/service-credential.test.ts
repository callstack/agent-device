import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { prepareHostServiceCredential } from './service-credential.ts';

function hostDir(): string {
  return path.join(mkdtempForTestSync('agent-device-host-credential-'), 'host');
}

function publishedCredential(dir: string) {
  const prepared = prepareHostServiceCredential(dir);
  prepared.publish();
  return prepared;
}

function refusalReason(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    return error.details?.reason;
  }
  assert.fail('expected the credential to be refused');
}

test('a new credential reaches disk only when Host publishes it', () => {
  const dir = hostDir();
  const prepared = prepareHostServiceCredential(dir);

  assert.equal(prepared.created, true);
  assert.equal(fs.existsSync(prepared.credentialFile), false);
  prepared.publish();

  assert.equal(prepared.credentialFile, path.join(dir, 'service-credential.json'));
  assert.match(prepared.credential.token, /^[0-9a-f]{64}$/);
  assert.equal(prepared.credential.principal, `host-svc-${prepared.credential.credentialId}`);
  assert.equal(fs.statSync(prepared.credentialFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('a restart reuses the same credential instead of issuing a new token', () => {
  const dir = hostDir();
  const first = publishedCredential(dir);
  const afterRestart = prepareHostServiceCredential(dir);

  assert.equal(afterRestart.created, false);
  assert.deepEqual(afterRestart.credential, first.credential);
});

test('a credential file readable by group or others refuses to start', () => {
  const dir = hostDir();
  const { credentialFile } = publishedCredential(dir);
  fs.chmodSync(credentialFile, 0o644);

  assert.equal(
    refusalReason(() => prepareHostServiceCredential(dir)),
    'host-credential-insecure',
  );
});

test('a credential directory open to group or others refuses to start', () => {
  const dir = hostDir();
  publishedCredential(dir);
  fs.chmodSync(dir, 0o755);

  assert.equal(
    refusalReason(() => prepareHostServiceCredential(dir)),
    'host-credential-insecure',
  );
});

test('a credential that is a link is refused with a typed reason', () => {
  const dir = hostDir();
  const { credentialFile } = publishedCredential(dir);
  const target = `${credentialFile}.real`;
  fs.renameSync(credentialFile, target);
  fs.symlinkSync(target, credentialFile);

  assert.equal(
    refusalReason(() => prepareHostServiceCredential(dir)),
    'host-credential-insecure',
  );
});

test('a malformed credential file is refused and never regenerated', () => {
  const dir = hostDir();
  const { credentialFile } = publishedCredential(dir);
  fs.writeFileSync(credentialFile, '{"version":1,"token":"short"}\n', { mode: 0o600 });

  assert.equal(
    refusalReason(() => prepareHostServiceCredential(dir)),
    'host-credential-invalid',
  );
  assert.equal(fs.readFileSync(credentialFile, 'utf8'), '{"version":1,"token":"short"}\n');
});

test('a credential another start published first is a typed refusal, never an overwrite', () => {
  const dir = hostDir();
  const late = prepareHostServiceCredential(dir);
  const winner = publishedCredential(dir);

  assert.equal(
    refusalReason(() => late.publish()),
    'host-credential-raced',
  );
  assert.deepEqual(prepareHostServiceCredential(dir).credential, winner.credential);
});
