import { expect, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import {
  cleanupRetainedMaterializedPaths,
  cleanupRetainedMaterializedPathsForSession,
  retainMaterializedPaths,
} from '../materialized-path-registry.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit';

test.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 2_147_483_648])(
  'retainMaterializedPaths rejects invalid TTL %s before filesystem work',
  async (ttlMs) => {
    const error = await retainMaterializedPaths({ installablePath: '/missing', ttlMs }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INVALID_ARGS');
  },
);

test('maximum TTL schedules the supported delay and reports matching expiry', async () => {
  vi.useFakeTimers();
  const now = new Date('2025-01-01T00:00:00.000Z');
  vi.setSystemTime(now);
  const tempRoot = mkdtempForTestSync('agent-device-retained-max-ttl-');
  const appPath = path.join(tempRoot, 'Sample.app');
  fs.mkdirSync(appPath);
  try {
    const retained = await retainMaterializedPaths({
      installablePath: appPath,
      ttlMs: 2_147_483_647,
    });
    expect(retained.expiresAt).toBe(new Date(now.getTime() + 2_147_483_647).toISOString());
    await vi.advanceTimersByTimeAsync(2_147_483_646);
    expect(fs.existsSync(retained.installablePath)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(fs.existsSync(retained.installablePath)).toBe(false));
  } finally {
    vi.useRealTimers();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('retainMaterializedPaths copies file and directory artifacts into managed storage', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-retained-paths-');
  const archivePath = path.join(tempRoot, 'Sample.zip');
  const appPath = path.join(tempRoot, 'Sample.app');
  fs.writeFileSync(archivePath, 'archive-bytes');
  fs.mkdirSync(appPath, { recursive: true });
  fs.writeFileSync(path.join(appPath, 'Info.plist'), 'plist');

  const retained = await retainMaterializedPaths({
    archivePath,
    installablePath: appPath,
    ttlMs: 60_000,
  });

  assert.notEqual(retained.archivePath, archivePath);
  assert.notEqual(retained.installablePath, appPath);
  assert.equal(fs.existsSync(retained.archivePath ?? ''), true);
  assert.equal(fs.existsSync(retained.installablePath), true);
  assert.equal(fs.readFileSync(retained.archivePath ?? '', 'utf8'), 'archive-bytes');
  assert.equal(fs.readFileSync(path.join(retained.installablePath, 'Info.plist'), 'utf8'), 'plist');

  await cleanupRetainedMaterializedPaths(retained.materializationId);
  assert.equal(fs.existsSync(retained.archivePath ?? ''), false);
  assert.equal(fs.existsSync(retained.installablePath), false);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('cleanupRetainedMaterializedPathsForSession removes retained paths bound to a session', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-retained-session-');
  const appPath = path.join(tempRoot, 'Sample.app');
  fs.mkdirSync(appPath, { recursive: true });
  fs.writeFileSync(path.join(appPath, 'Info.plist'), 'plist');

  const retained = await retainMaterializedPaths({
    installablePath: appPath,
    sessionName: 'session-one',
    ttlMs: 60_000,
  });

  assert.equal(fs.existsSync(retained.installablePath), true);
  await cleanupRetainedMaterializedPathsForSession('session-one');
  assert.equal(fs.existsSync(retained.installablePath), false);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('cleanup of unknown materialization reports expiry with a recovery hint', async () => {
  const error = await cleanupRetainedMaterializedPaths('missing-id').then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal(error instanceof AppError, true);
  const appError = error as AppError;
  assert.equal(appError.code, 'COMMAND_FAILED');
  assert.equal(appError.message, 'Materialized paths not found or expired: missing-id');
  assert.equal(appError.details?.reason, 'RESOURCE_EXPIRED');
  assert.equal(typeof appError.details?.hint, 'string');
});

test('cleanup of tenant-owned materialization rejects other tenants', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-retained-tenant-');
  const appPath = path.join(tempRoot, 'Sample.app');
  fs.mkdirSync(appPath, { recursive: true });

  const retained = await retainMaterializedPaths({
    installablePath: appPath,
    tenantId: 'tenant-a',
    ttlMs: 60_000,
  });

  const error = await cleanupRetainedMaterializedPaths(retained.materializationId, 'tenant-b').then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal(error instanceof AppError, true);
  assert.equal((error as AppError).code, 'UNAUTHORIZED');
  assert.equal(fs.existsSync(retained.installablePath), true);

  await cleanupRetainedMaterializedPaths(retained.materializationId, 'tenant-a');
  assert.equal(fs.existsSync(retained.installablePath), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('TTL expiry cleans up tenant-owned materializations without a tenant context', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-retained-ttl-');
  const appPath = path.join(tempRoot, 'Sample.app');
  fs.mkdirSync(appPath, { recursive: true });

  const retained = await retainMaterializedPaths({
    installablePath: appPath,
    tenantId: 'tenant-a',
    ttlMs: 20,
  });

  const deadline = Date.now() + 5_000;
  while (fs.existsSync(retained.installablePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(retained.installablePath), false);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
