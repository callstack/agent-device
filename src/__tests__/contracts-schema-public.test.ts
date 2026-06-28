import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AppError,
  type BootCommandResult,
  type CommandResult,
  type ShutdownCommandResult,
  type ViewportCommandResult,
} from '../index.ts';
import {
  defaultHintForCode,
  daemonCommandRequestSchema,
  daemonRuntimeSchema,
  centerOfRect,
  jsonRpcRequestSchema,
  leaseAllocateSchema,
  leaseHeartbeatSchema,
  leaseReleaseSchema,
  normalizeError,
  type AppErrorCode,
  type Rect,
  type SnapshotNode,
} from '../contracts.ts';

const invalidArgsCode = 'INVALID_ARGS' satisfies AppErrorCode;
const rect = { x: 1, y: 2, width: 3, height: 4 } satisfies Rect;
const node = {
  index: 0,
  ref: 'e1',
  type: 'Button',
  label: 'Continue',
  rect,
} satisfies SnapshotNode;

test('public contracts error helpers do not load diagnostics module', () => {
  const errorsSource = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'utils', 'errors.ts'),
    'utf8',
  );

  assert.doesNotMatch(errorsSource, /['"]\.\/diagnostics\.ts['"]/);
  assert.doesNotMatch(errorsSource, /node:/);
});

test('public contract schemas validate daemon requests and lease payloads', () => {
  const runtime = daemonRuntimeSchema.parse({
    platform: 'ios',
    metroHost: '127.0.0.1',
    metroPort: 8081,
    bundleUrl: 'https://example.test/index.bundle?platform=ios',
  });
  const request = daemonCommandRequestSchema.parse({
    command: 'open',
    positionals: ['Demo'],
    runtime,
    meta: {
      tenantId: 'acme',
      runId: 'run-1',
      leaseBackend: 'ios-instance',
      lockPolicy: 'reject',
      lockPlatform: 'ios',
    },
  });
  const allocate = leaseAllocateSchema.parse({
    tenantId: 'acme',
    runId: 'run-1',
    ttlMs: 60_000,
    backend: 'android-instance',
  });
  const heartbeat = leaseHeartbeatSchema.parse({
    tenantId: 'acme',
    runId: 'run-1',
    leaseId: 'lease-1',
    ttlMs: 60_000,
  });
  const release = leaseReleaseSchema.parse({
    tenant: 'acme',
    runId: 'run-1',
    leaseId: 'lease-1',
  });

  assert.equal(request.runtime?.platform, 'ios');
  assert.equal(request.meta?.leaseBackend, 'ios-instance');
  assert.equal(request.session, undefined);
  assert.equal(allocate.backend, 'android-instance');
  assert.equal(heartbeat.runId, 'run-1');
  assert.equal(release.tenant, 'acme');
  assert.equal(heartbeat.leaseId, 'lease-1');
  assert.equal(release.leaseId, 'lease-1');
  assert.deepEqual(centerOfRect(rect), { x: 3, y: 4 });
  assert.equal(node.ref, 'e1');
});

test('public root exports typed command result contracts', () => {
  const boot = {
    platform: 'ios',
    target: 'mobile',
    device: 'iPhone 17',
    id: 'booted-device',
    kind: 'simulator',
    booted: true,
  } satisfies BootCommandResult;
  const bootFromMap: CommandResult<'boot'> = boot;

  const shutdown = {
    platform: 'ios',
    target: 'mobile',
    device: 'iPhone 17',
    id: 'shutdown-device',
    kind: 'simulator',
    shutdown: {
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
  } satisfies ShutdownCommandResult;
  const shutdownFromMap: CommandResult<'shutdown'> = shutdown;

  const viewport = {
    width: 390,
    height: 844,
    message: 'Viewport is 390x844',
  } satisfies ViewportCommandResult;
  const viewportFromMap: CommandResult<'viewport'> = viewport;

  assert.equal(bootFromMap.booted, true);
  assert.equal(shutdownFromMap.shutdown.success, true);
  assert.equal(viewportFromMap.width, 390);
});

test('public daemon request schema accepts GitHub Actions artifact install sources', () => {
  const artifactIdRequest = daemonCommandRequestSchema.parse({
    command: 'install_source',
    positionals: [],
    flags: { platform: 'android' },
    meta: {
      installSource: {
        kind: 'github-actions-artifact',
        owner: 'acme',
        repo: 'mobile',
        artifactId: 1234567890,
      },
    },
  });
  const artifactNameRequest = daemonCommandRequestSchema.parse({
    command: 'install_source',
    positionals: [],
    flags: { platform: 'ios' },
    meta: {
      installSource: {
        kind: 'github-actions-artifact',
        owner: 'acme',
        repo: 'mobile',
        runId: 987654321,
        artifactName: 'app-debug',
      },
    },
  });
  const latestArtifactNameRequest = daemonCommandRequestSchema.parse({
    command: 'install_source',
    positionals: [],
    flags: { platform: 'android' },
    meta: {
      installSource: {
        kind: 'github-actions-artifact',
        owner: 'acme',
        repo: 'mobile',
        artifactName: 'app-debug',
      },
    },
  });

  assert.deepEqual(artifactIdRequest.meta?.installSource, {
    kind: 'github-actions-artifact',
    owner: 'acme',
    repo: 'mobile',
    artifactId: 1234567890,
  });
  assert.deepEqual(artifactNameRequest.meta?.installSource, {
    kind: 'github-actions-artifact',
    owner: 'acme',
    repo: 'mobile',
    runId: 987654321,
    artifactName: 'app-debug',
  });
  assert.deepEqual(latestArtifactNameRequest.meta?.installSource, {
    kind: 'github-actions-artifact',
    owner: 'acme',
    repo: 'mobile',
    artifactName: 'app-debug',
  });
  assert.throws(
    () =>
      daemonCommandRequestSchema.parse({
        command: 'install_source',
        positionals: [],
        meta: {
          installSource: {
            kind: 'github-actions-artifact',
            owner: 'acme',
            repo: 'mobile',
            artifactId: 1234567890,
            runId: 987654321,
            artifactName: 'app-debug',
          },
        },
      }),
    /either artifactId or artifactName, not both/,
  );
  assert.throws(
    () =>
      daemonCommandRequestSchema.parse({
        command: 'install_source',
        positionals: [],
        meta: {
          installSource: {
            kind: 'github-actions-artifact',
            owner: ' ',
            repo: 'mobile',
          },
        },
      }),
    /owner/,
  );
});

test('public contract exports normalize and hint app errors', () => {
  const normalized = normalizeError(new AppError(invalidArgsCode, 'Invalid command'));

  assert.equal(normalized.code, invalidArgsCode);
  assert.equal(normalized.hint, defaultHintForCode(invalidArgsCode));
  assert.equal(
    defaultHintForCode('UNKNOWN'),
    'Retry with --debug and inspect diagnostics log for details.',
  );
});

test('public contract schemas reject invalid payloads', () => {
  assert.throws(
    () =>
      daemonCommandRequestSchema.parse({
        token: 'secret',
        session: 'default',
        command: 'open',
        positionals: [123],
      }),
    /positionals\[0\]/,
  );
  assert.throws(
    () =>
      jsonRpcRequestSchema.parse({
        jsonrpc: '2.0',
        id: {},
        method: 'agent_device.command',
      }),
    /\.id/,
  );
  assert.throws(
    () =>
      leaseReleaseSchema.parse({
        token: 'secret',
        leaseId: 'lease-1',
        ttlMs: 60_000,
      }),
    /\.ttlMs/,
  );
});
