import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  HTTP_ALLOW_HOST_PATH_INSTALL_ENV,
  HTTP_HOST_PATH_INSTALL_ROOT_ENV,
  confineHttpInstallSourcePath,
  resolveHttpTrustPolicy,
} from './http-trust-policy.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

test('remote host-path opt-in fails closed without an approved root', async () => {
  await assert.rejects(
    resolveHttpTrustPolicy({
      authHookConfigured: true,
      env: { [HTTP_ALLOW_HOST_PATH_INSTALL_ENV]: 'true' },
    }),
    new RegExp(
      `${HTTP_ALLOW_HOST_PATH_INSTALL_ENV} requires ${HTTP_HOST_PATH_INSTALL_ROOT_ENV}`,
      'i',
    ),
  );
});

test('remote host-path opt-in resolves a symlinked approved root', async () => {
  const parent = mkdtempForTestSync('agent-device-http-trust-root-');
  const root = path.join(parent, 'root');
  const rootLink = path.join(parent, 'root-link');
  fs.mkdirSync(root);
  fs.symlinkSync(root, rootLink);

  try {
    const policy = await resolveHttpTrustPolicy({
      authHookConfigured: true,
      env: {
        [HTTP_ALLOW_HOST_PATH_INSTALL_ENV]: 'yes',
        [HTTP_HOST_PATH_INSTALL_ROOT_ENV]: rootLink,
      },
    });
    assert.equal(policy.networkAccess, 'public-only');
    assert.equal(policy.hostPathInstallRoot, fs.realpathSync(root));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('path confinement returns the canonical target and rejects a symlink escape', async () => {
  const parent = mkdtempForTestSync('agent-device-http-trust-path-');
  const root = path.join(parent, 'root');
  const inside = path.join(root, 'inside.apk');
  const outside = path.join(parent, 'outside.apk');
  const link = path.join(root, 'outside-link.apk');
  fs.mkdirSync(root);
  fs.writeFileSync(inside, 'inside');
  fs.writeFileSync(outside, 'outside');
  fs.symlinkSync(outside, link);

  try {
    const approvedRoot = fs.realpathSync(root);
    assert.equal(await confineHttpInstallSourcePath(inside, approvedRoot), fs.realpathSync(inside));
    await assert.rejects(
      confineHttpInstallSourcePath(link, approvedRoot),
      (error: unknown) =>
        error instanceof Error && error.message.includes('resolves outside the approved root'),
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
