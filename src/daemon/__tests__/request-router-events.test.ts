import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequestHandler } from '../request-router.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { makeIosSession } from '../../__tests__/test-utils/index.ts';

test('events reads the daemon-owned session timeline without appending poll noise', async () => {
  const sessionStore = makeSessionStore('agent-device-router-events-');
  sessionStore.recordEvent('events-session', {
    kind: 'action.recorded',
    command: 'click',
    summary: 'Tapped @14 (10, 20)',
    details: { ref: '14', x: 10, y: 20 },
  });
  const eventLogPath = sessionStore.resolveEventLogPath('events-session');

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
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
  sessionStore.recordEvent('events-session', {
    kind: 'action.recorded',
    command: 'open',
    summary: 'Opened session',
  });
  sessionStore.recordEvent('events-session', {
    kind: 'action.recorded',
    command: 'click',
    summary: 'Tapped @14',
  });

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
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
  sessionStore.recordEvent('events-session', {
    kind: 'action.recorded',
    command: 'open',
    summary: 'Opened session',
  });

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
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
  sessionStore.recordEvent('events-session', {
    kind: 'action.recorded',
    command: 'open',
    summary: 'Opened session',
  });

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
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

test('request timeline records thrown request failures after scope creation', async () => {
  const sessionStore = makeSessionStore('agent-device-router-events-throws-');
  sessionStore.set('events-session', makeIosSession('events-session'));

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
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
  await sessionStore.flushEvents('events-session');
  const page = sessionStore.readEvents('events-session');
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

test('request timeline records setup failures after start is appended', async () => {
  const sessionStore = makeSessionStore('agent-device-router-events-setup-failure-');

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'open',
    positionals: ['Expo Go'],
    flags: {},
    meta: { requestId: 'req-proxy-open', leaseProvider: 'proxy' },
  });

  expect(response.ok).toBe(false);
  await sessionStore.flushEvents('default');
  const page = sessionStore.readEvents('default');
  expect(page.events).toEqual([
    expect.objectContaining({
      kind: 'request.started',
      command: 'open',
      requestId: 'req-proxy-open',
    }),
    expect.objectContaining({
      kind: 'request.finished',
      command: 'open',
      requestId: 'req-proxy-open',
      status: 'error',
    }),
  ]);
});
