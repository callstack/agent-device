import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
  resolveSessionScreenshotNamePrefix,
  resolveSessionScreenshotStagingDir,
  resolveSessionScreenshotsDir,
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

test('a capture without a destination mints a per-capture file that failure cleanup removes', async () => {
  const sessionDir = mkdtempForTestSync('minted-session-');
  const mintDir = resolveSessionScreenshotsDir(sessionDir);
  const adapter = createDaemonScreenshotArtifactAdapter(false, undefined, {
    mintDir,
    requestNamePrefix: resolveSessionScreenshotNamePrefix('req:flow:1'),
  });

  const first = await adapter.reserveOutput(undefined, outputOptions);
  expect(path.dirname(first.path)).toBe(mintDir);
  expect(path.basename(first.path)).toMatch(/^req_flow_1-.+\.png$/);
  fs.writeFileSync(first.path, 'first');
  await first.publish();
  expect(fs.readFileSync(first.path, 'utf8')).toBe('first');

  // A second capture of the same request mints a distinct file: no capture overwrites another.
  const second = await adapter.reserveOutput(undefined, outputOptions);
  expect(second.path).not.toBe(first.path);
  fs.writeFileSync(second.path, 'second');

  // The capture this reservation published stays; a failed sibling's own file is removed.
  await second.cleanup?.();
  expect(fs.existsSync(second.path)).toBe(false);
  expect(fs.readFileSync(first.path, 'utf8')).toBe('first');
  await first.cleanup?.();
  expect(fs.readFileSync(first.path, 'utf8')).toBe('first');
});

test('a crop capture without a destination stages and publishes to its own minted file', async () => {
  const sessionDir = mkdtempForTestSync('minted-crop-session-');
  const mintDir = resolveSessionScreenshotsDir(sessionDir);
  const stagingDir = resolveSessionScreenshotStagingDir(sessionDir);
  const reserved = await createDaemonScreenshotArtifactAdapter(true, undefined, {
    mintDir,
    requestNamePrefix: resolveSessionScreenshotNamePrefix('req-crop'),
    stagingDir,
  }).reserveOutput(undefined, outputOptions);

  expect(reserved.publishedPath).not.toBeUndefined();
  expect(path.dirname(reserved.publishedPath!)).toBe(mintDir);
  expect(path.basename(reserved.publishedPath!)).toMatch(/^req-crop-.+\.png$/);
  expect(fs.existsSync(reserved.publishedPath!)).toBe(false);
  fs.writeFileSync(reserved.path, 'cropped image');
  await reserved.publish();

  // The staged crop reaches the minted destination only after publish: a failed capture
  // before this point leaves no bytes at any destination.
  expect(fs.readFileSync(reserved.publishedPath!, 'utf8')).toBe('cropped image');
  await reserved.cleanup?.();
  expect(fs.existsSync(reserved.path)).toBe(false);
});

test('a crop capture failure without a destination leaves the minted dir without new bytes', async () => {
  const sessionDir = mkdtempForTestSync('minted-crop-failure-');
  const mintDir = resolveSessionScreenshotsDir(sessionDir);
  fs.mkdirSync(mintDir, { recursive: true });
  fs.writeFileSync(path.join(mintDir, 'earlier.png'), 'earlier');
  const stagingDir = resolveSessionScreenshotStagingDir(sessionDir);
  const reserved = await createDaemonScreenshotArtifactAdapter(true, undefined, {
    mintDir,
    requestNamePrefix: resolveSessionScreenshotNamePrefix('req-crop-fail'),
    stagingDir,
  }).reserveOutput(undefined, outputOptions);
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
  expect(fs.readdirSync(mintDir).filter((entry) => entry !== 'crop-staging')).toEqual([
    'earlier.png',
  ]);
  expect(fs.readdirSync(stagingDir)).toEqual([]);
});

test('crop staging mints a per-request dir inside the session staging root and its cleanup spares the published destination', async () => {
  const sessionDir = mkdtempForTestSync('crop-staging-session-');
  const stagingDir = resolveSessionScreenshotStagingDir(sessionDir);
  const destination = path.join(sessionDir, 'crop.png');
  const reserved = await createDaemonScreenshotArtifactAdapter(true, undefined, {
    stagingDir,
  }).reserveOutput({ kind: 'path', path: destination }, outputOptions);

  expect(reserved.path.startsWith(stagingDir)).toBe(true);
  const stagingUnit = path.dirname(reserved.path);
  expect(stagingUnit).not.toBe(stagingDir);
  fs.writeFileSync(reserved.path, 'cropped image');
  await reserved.publish();

  expect(fs.readFileSync(destination, 'utf8')).toBe('cropped image');
  await reserved.cleanup?.();
  expect(fs.existsSync(stagingUnit)).toBe(false);
  expect(fs.readdirSync(stagingDir)).toEqual([]);
  expect(fs.readFileSync(destination, 'utf8')).toBe('cropped image');

  // The next request mints its own staging dir, so two publishes never share one path.
  const next = await createDaemonScreenshotArtifactAdapter(true, undefined, {
    stagingDir,
  }).reserveOutput({ kind: 'path', path: destination }, outputOptions);
  try {
    expect(path.dirname(next.path).startsWith(stagingDir)).toBe(true);
    expect(path.dirname(next.path)).not.toBe(stagingUnit);
    expect(fs.existsSync(path.dirname(next.path))).toBe(true);
  } finally {
    await next.cleanup?.();
  }
  expect(fs.existsSync(path.dirname(next.path))).toBe(false);
});

test('a crop publish failure leaves only the request staging dir removable and the destination absent', async () => {
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
  expect(fs.existsSync(path.dirname(reserved.path))).toBe(false);
  expect(fs.readdirSync(stagingDir)).toEqual([]);
});
