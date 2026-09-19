import { expect, test } from 'vitest';
import type { DaemonRequest } from '../../../daemon-request.ts';
import { maestroOperationDaemonRequest } from '../session-replay-maestro-request.ts';

const replay: DaemonRequest = {
  token: 'nested-token',
  session: 'maestro-nested',
  command: 'replay',
  positionals: ['flow.yaml'],
  flags: { replayBackend: 'maestro' },
  meta: {
    debug: true,
    includeCost: true,
    responseLevel: 'full',
    sessionIsolation: 'tenant',
  },
  runtime: {
    platform: 'android',
    metroHost: '127.0.0.1',
    metroPort: 8081,
    bundleUrl: 'http://127.0.0.1:8081/index.bundle',
  },
  internal: { publicNetworkOnly: true },
};

test('keeps the replay request envelope and replaces the command it carried', () => {
  const request = maestroOperationDaemonRequest(replay, {
    command: 'open',
    positionals: ['com.example.app'],
    flags: { platform: 'android', target: 'mobile', noRecord: true, relaunch: true },
  });

  expect(request).toEqual({
    token: 'nested-token',
    session: 'maestro-nested',
    meta: replay.meta,
    runtime: replay.runtime,
    command: 'open',
    positionals: ['com.example.app'],
    flags: { platform: 'android', target: 'mobile', noRecord: true, relaunch: true },
    internal: { publicNetworkOnly: true },
  });
  expect(request).not.toHaveProperty('input');
});

test('folds the dispatch options into the request-private half beside the replay state', () => {
  const viewport = { x: 0, y: 100, width: 402, height: 650 };
  const request = maestroOperationDaemonRequest(replay, {
    command: 'gesture',
    positionals: [],
    input: { kind: 'pan', origin: { x: 1, y: 2 }, delta: { x: -3, y: 0 }, durationMs: 300 },
    dispatch: { gestureExecutionProfile: 'endpoint-hold', gestureViewport: viewport },
  });

  expect(request.internal).toEqual({
    publicNetworkOnly: true,
    gestureExecutionProfile: 'endpoint-hold',
    gestureViewport: viewport,
  });
  expect(request.input).toEqual({
    kind: 'pan',
    origin: { x: 1, y: 2 },
    delta: { x: -3, y: 0 },
    durationMs: 300,
  });
});

test('omits internal entirely when neither side carries request-private state', () => {
  const request = maestroOperationDaemonRequest(
    { token: 'token', session: 'session', command: 'replay', positionals: [] },
    { command: 'snapshot', positionals: [], flags: { noRecord: true } },
  );

  expect(request).toEqual({
    token: 'token',
    session: 'session',
    command: 'snapshot',
    positionals: [],
    flags: { noRecord: true },
  });
});

test('marks projected hierarchy captures as observation-only for the daemon', () => {
  const request = maestroOperationDaemonRequest(
    { token: 'token', session: 'session', command: 'replay', positionals: [] },
    { command: 'snapshot', positionals: [], dispatch: { observationOnly: true } },
  );

  expect(request.internal).toEqual({ observationOnly: true });
});

test('folds Maestro settings app targeting into the request-private half', () => {
  const request = maestroOperationDaemonRequest(
    { token: 'token', session: 'session', command: 'replay', positionals: [] },
    {
      command: 'settings',
      positionals: ['permission', 'grant', 'camera'],
      dispatch: { settingsAppBundleId: 'com.example.app' },
    },
  );

  expect(request.internal).toEqual({ settingsAppBundleId: 'com.example.app' });
});

test('leaves request-private state the operation does not set untouched', () => {
  const viewport = { x: 0, y: 0, width: 402, height: 874 };
  const request = maestroOperationDaemonRequest(
    {
      token: 'token',
      session: 'session',
      command: 'replay',
      positionals: [],
      internal: { publicNetworkOnly: true, gestureViewport: viewport },
    },
    { command: 'open', positionals: [], dispatch: { closeAppOnly: true } },
  );

  expect(request.internal).toEqual({
    publicNetworkOnly: true,
    gestureViewport: viewport,
    closeAppOnly: true,
  });
});
