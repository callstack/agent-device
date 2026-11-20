import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
  resolveSessionScreenshotPath,
  resolveSessionScreenshotStagingDir,
} from '@agent-device/daemon-contracts/session-artifact-paths';
import { createDaemonScreenshotArtifactAdapter } from './screenshot-artifact-adapter.ts';

const outputOptions = { field: 'path', ext: '.png', artifactType: 'screenshot' as const };

test('crop publication updates the regular symlink target without replacing the link', async () => {
  const root = mkdtempForTestSync('crop-symlink');
  const destination = path.join(root, 'latest.png');
  const target = path.join(root, 'dated.png');
  fs.writeFileSync(target, 'previous', { mode: 0o600 });
  fs.symlinkSync('dated.png', destination);
  const reserved = await createDaemonScreenshotArtifactAdapter(true, undefined).reserveOutput(
    { kind: 'path', path: destination },
    outputOptions,
  );
  try {
    fs.writeFileSync(reserved.path, 'complete image');
    await reserved.publish();
    expect(reserved.publishedPath).toBe(destination);
    expect(fs.readlinkSync(destination)).toBe('dated.png');
    expect(fs.readFileSync(target, 'utf8')).toBe('complete image');
    if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.dirname(reserved.path))).toBe(false);
  } finally {
    await reserved.cleanup?.();
  }
});

test('a dangling destination symlink is refused without replacing it', async () => {
  const root = mkdtempForTestSync('crop-dangling');
  const destination = path.join(root, 'latest.png');
  fs.symlinkSync('missing.png', destination);
  await expect(
    createDaemonScreenshotArtifactAdapter(true, undefined).reserveOutput(
      { kind: 'path', path: destination },
      outputOptions,
    ),
  ).rejects.toMatchObject({
    code: 'INVALID_ARGS',
    message: 'Screenshot destination is a dangling symbolic link',
    details: { reason: 'screenshot_destination_dangling_symlink', path: destination },
  });
  expect(fs.readlinkSync(destination)).toBe('missing.png');
  expect(fs.existsSync(path.join(root, 'missing.png'))).toBe(false);
});

test('a directory destination is refused before a capture is reserved', async () => {
  const destination = mkdtempForTestSync('crop-directory');
  await expect(
    createDaemonScreenshotArtifactAdapter(true, undefined).reserveOutput(
      { kind: 'path', path: destination },
      outputOptions,
    ),
  ).rejects.toMatchObject({
    code: 'INVALID_ARGS',
    details: { reason: 'screenshot_destination_not_file' },
  });
});

for (const existing of [true, false]) {
  test(`failed atomic publication preserves the ${existing ? 'existing' : 'absent'} destination with a typed reason`, async () => {
    const root = mkdtempForTestSync('crop-publish-failure');
    const destination = path.join(root, 'capture.png');
    if (existing) fs.writeFileSync(destination, 'previous');
    const reserved = await createDaemonScreenshotArtifactAdapter(true, undefined).reserveOutput(
      { kind: 'path', path: destination },
      outputOptions,
    );
    fs.writeFileSync(reserved.path, 'complete image');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    try {
      await expect(reserved.publish()).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        details: { reason: 'screenshot_publication_failed', filesystemCode: 'ENOSPC' },
      });
      if (existing) expect(fs.readFileSync(destination, 'utf8')).toBe('previous');
      else expect(fs.existsSync(destination)).toBe(false);
      expect(fs.readdirSync(root)).toEqual(existing ? ['capture.png'] : []);
    } finally {
      rename.mockRestore();
      await reserved.cleanup?.();
    }
    expect(fs.existsSync(path.dirname(reserved.path))).toBe(false);
  });
}

test('automatic crop output retains cancellation and owned-file cleanup before publication', async () => {
  const controller = new AbortController();
  const cancellation = new Error('cancelled after crop');
  const reserved = await createDaemonScreenshotArtifactAdapter(
    true,
    controller.signal,
  ).reserveOutput(undefined, outputOptions);
  fs.writeFileSync(reserved.path, 'completed crop');
  controller.abort(cancellation);
  try {
    await expect(reserved.publish()).rejects.toBe(cancellation);
  } finally {
    await reserved.cleanup?.();
  }
  expect(fs.existsSync(path.dirname(reserved.path))).toBe(false);
});

test('a capture without a destination lands on the stable session path and stays there', async () => {
  const sessionDir = mkdtempForTestSync('stable-session-');
  const adapter = createDaemonScreenshotArtifactAdapter(false, undefined, {
    defaultPath: resolveSessionScreenshotPath(sessionDir),
  });
  const stablePath = resolveSessionScreenshotPath(sessionDir);

  const first = await adapter.reserveOutput(undefined, outputOptions);
  expect(first.path).toBe(stablePath);
  fs.writeFileSync(first.path, 'first');
  await first.publish();
  expect(fs.readFileSync(stablePath, 'utf8')).toBe('first');

  // A second capture in the same session predicts the same file: no minted temp path to parse.
  const second = await adapter.reserveOutput(undefined, outputOptions);
  expect(second.path).toBe(stablePath);
  expect(first.cleanup).toBeUndefined();
  expect(second.cleanup).toBeUndefined();
});

test('crop staging runs inside the session dir and its cleanup spares the published destination', async () => {
  const sessionDir = mkdtempForTestSync('crop-staging-session-');
  const stagingDir = resolveSessionScreenshotStagingDir(sessionDir);
  const destination = path.join(sessionDir, 'crop.png');
  const reserved = await createDaemonScreenshotArtifactAdapter(true, undefined, {
    stagingDir,
  }).reserveOutput({ kind: 'path', path: destination }, outputOptions);

  expect(reserved.path.startsWith(stagingDir)).toBe(true);
  fs.writeFileSync(reserved.path, 'cropped image');
  await reserved.publish();

  expect(fs.readFileSync(destination, 'utf8')).toBe('cropped image');
  await reserved.cleanup?.();
  expect(fs.existsSync(stagingDir)).toBe(false);
  expect(fs.readFileSync(destination, 'utf8')).toBe('cropped image');
});

test('a crop publish failure leaves the session staging dir removable and the destination absent', async () => {
  const sessionDir = mkdtempForTestSync('crop-staging-failure-');
  const stagingDir = resolveSessionScreenshotStagingDir(sessionDir);
  const destination = path.join(sessionDir, 'elsewhere.png');
  const reserved = await createDaemonScreenshotArtifactAdapter(true, undefined, {
    stagingDir,
  }).reserveOutput({ kind: 'path', path: destination }, outputOptions);
  fs.writeFileSync(reserved.path, 'complete image');
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  });
  try {
    await expect(reserved.publish()).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason: 'screenshot_publication_failed' },
    });
  } finally {
    rename.mockRestore();
    await reserved.cleanup?.();
  }
  expect(fs.existsSync(destination)).toBe(false);
  expect(fs.existsSync(stagingDir)).toBe(false);
});
