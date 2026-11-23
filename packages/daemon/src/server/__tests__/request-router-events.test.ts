import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { test, expect } from 'vitest';
import fs from 'node:fs';

import path from 'node:path';
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { makeIosSession, makeSession } from '../../__tests__/support/session-factories.ts';
import {
  mkdtempForTestSync,
  WEB_DESKTOP_DEVICE,
  createTestHostEnvironment,
} from '@agent-device/test-kit';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';

test('events reads the daemon-owned session timeline without appending poll noise', async () => {
  const sessionStore = makeSessionStore('agent-device-router-events-');
  const ref = sessionStore.publish('events-session', makeIosSession('events-session'));
  sessionStore.recordEvent(ref, {
    kind: 'action.recorded',
    command: 'click',
    summary: 'Tapped @14 (10, 20)',
    details: { ref: '14', x: 10, y: 20 },
  });
  const eventLogPath = sessionStore.resolveEventLogPath(ref);

  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'events-session',
    command: 'events',
    positionals: ['10'],
    flags: {},
    meta: { requestId: 'req-events' },
  });

  expect(response.ok).toBe(true);
  if (!response.ok) return;
  expect(response.data?.path).toBe(eventLogPath);
  expect(response.data?.events).toEqual([
    expect.objectContaining({
      kind: 'action.recorded',
      command: 'click',
      summary: 'Tapped @14 (10, 20)',
    }),
  ]);
  expect(fs.readFileSync(eventLogPath, 'utf8').trim().split('\n')).toHaveLength(1);
});

test('events accepts a blank limit placeholder for cursor-only reads', async () => {
  const sessionStore = makeSessionStore('agent-device-router-events-cursor-');
  const ref = sessionStore.publish('events-session', makeIosSession('events-session'));
  sessionStore.recordEvent(ref, {
    kind: 'action.recorded',
    command: 'open',
    summary: 'Opened session',
  });
  sessionStore.recordEvent(ref, {
    kind: 'action.recorded',
    command: 'click',
    summary: 'Tapped @14',
  });

  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'events-session',
    command: 'events',
    positionals: ['', '1'],
    flags: {},
    meta: { requestId: 'req-events-cursor' },
  });

  expect(response.ok).toBe(true);
  if (!response.ok) return;
  expect(response.data?.cursor).toBe('1');
  expect(response.data?.limit).toBe(100);
  expect(response.data?.events).toEqual([
    expect.objectContaining({
      kind: 'action.recorded',
      command: 'click',
      summary: 'Tapped @14',
    }),
  ]);
});

test('events returns structured errors for invalid limit and cursor', async () => {
  const sessionStore = makeSessionStore('agent-device-router-events-invalid-');
  const ref = sessionStore.publish('events-session', makeIosSession('events-session'));
  sessionStore.recordEvent(ref, {
    kind: 'action.recorded',
    command: 'open',
    summary: 'Opened session',
  });

  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const invalidLimit = await handler({
    token: 'test-token',
    session: 'events-session',
    command: 'events',
    positionals: ['0'],
    flags: {},
    meta: { requestId: 'req-events-limit' },
  });
  const invalidCursor = await handler({
    token: 'test-token',
    session: 'events-session',
    command: 'events',
    positionals: ['10', 'abc'],
    flags: {},
    meta: { requestId: 'req-events-cursor' },
  });

  expect(invalidLimit).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGS', message: 'events limit must be between 1 and 500.' },
  });
  expect(invalidCursor).toMatchObject({
    ok: false,
    error: {
      code: 'INVALID_ARGS',
      message: 'events cursor must be a non-negative integer string.',
    },
  });
});

test('events flushes pending event writes before reading', async () => {
  const sessionStore = makeSessionStore('agent-device-router-events-flush-');
  const ref = sessionStore.publish('events-session', makeIosSession('events-session'));
  sessionStore.recordEvent(ref, {
    kind: 'action.recorded',
    command: 'open',
    summary: 'Opened session',
  });

  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'events-session',
    command: 'events',
    positionals: ['10'],
    flags: {},
    meta: { requestId: 'req-events-flush' },
  });

  expect(response.ok).toBe(true);
  if (!response.ok) return;
  expect(response.data?.events).toEqual([
    expect.objectContaining({ kind: 'action.recorded', summary: 'Opened session' }),
  ]);
});

// #1900: `events` reads/flushes the session-owned timeline (`session-observability.ts`) with no
// device-runtime binding at all, so a web-backed session exercises the exact same code path as
// every other platform.
test('events reads the daemon-owned session timeline for a web-backed session', async () => {
  const sessionStore = makeSessionStore('agent-device-router-events-web-');
  const ref = sessionStore.publish(
    'web-session',
    makeSession('web-session', { device: WEB_DESKTOP_DEVICE }),
  );
  sessionStore.recordEvent(ref, {
    kind: 'action.recorded',
    command: 'click',
    summary: 'Tapped Submit order',
  });

  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'web-session',
    command: 'events',
    positionals: ['10'],
    flags: {},
    meta: { requestId: 'req-events-web' },
  });

  expect(response.ok).toBe(true);
  if (!response.ok) return;
  expect(response.data?.events).toEqual([
    expect.objectContaining({
      kind: 'action.recorded',
      command: 'click',
      summary: 'Tapped Submit order',
    }),
  ]);
});

test('request timeline records thrown request failures after scope creation', async () => {
  const sessionStore = makeSessionStore('agent-device-router-events-throws-');
  const ref = sessionStore.publish('events-session', makeIosSession('events-session'));

  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'events-session',
    command: 'click',
    positionals: ['10', '20'],
    flags: { platform: 'android' },
    meta: { requestId: 'req-selector-conflict' },
  });

  expect(response.ok).toBe(false);
  await sessionStore.flushEvents(ref);
  const page = sessionStore.readEvents(ref);
  expect(page.events).toEqual([
    expect.objectContaining({
      kind: 'request.started',
      command: 'click',
      requestId: 'req-selector-conflict',
    }),
    expect.objectContaining({
      kind: 'request.finished',
      command: 'click',
      requestId: 'req-selector-conflict',
      status: 'error',
    }),
  ]);
});

test.each([
  { stage: 'lease preflight', meta: { leaseProvider: 'proxy' } },
  { stage: 'tenant routing', meta: { sessionIsolation: 'tenant', tenantId: 'invalid/tenant' } },
] as const)('a refusal during $stage writes a detached diagnostics record', async ({ meta }) => {
  const sessionStore = makeSessionStore('agent-device-router-events-setup-failure-');

  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'open',
    positionals: ['Expo Go'],
    flags: {},
    meta: { requestId: 'req-proxy-open', ...meta },
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.diagnosticsRecord?.requestId).toMatch(/^[a-f0-9]{32}-unleased$/);
  if ('tenantId' in meta) {
    expect(response.error.diagnosticsRecord?.session).toBe('request-diagnostics');
  }
  expect(fs.readFileSync(response.error.logPath!, 'utf8')).toContain('"phase":"request_failed"');
  expect(fs.existsSync(path.join(sessionStore.resolveDaemonStateDir(), 'session-journals'))).toBe(
    false,
  );
});
