import { expect, test } from 'vitest';
import type { ReplayDispatchRequest } from '../command-types.ts';
import { maestroOperationDispatchRequest } from '../session-replay-maestro-request.ts';

const replay: ReplayDispatchRequest = {
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
  dispatch: { observationOnly: true },
};

test('keeps the replay request envelope and replaces the command it carried', () => {
  const request = maestroOperationDispatchRequest(replay, {
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
    dispatch: { observationOnly: true },
  });
  expect(request).not.toHaveProperty('input');
});

test('folds the operation dispatch options beside the ones the replay carries', () => {
  const viewport = { x: 0, y: 100, width: 402, height: 650 };
  const request = maestroOperationDispatchRequest(replay, {
    command: 'gesture',
    positionals: [],
    input: { kind: 'pan', origin: { x: 1, y: 2 }, delta: { x: -3, y: 0 }, durationMs: 300 },
    dispatch: { gestureExecutionProfile: 'endpoint-hold', gestureViewport: viewport },
  });

  expect(request.dispatch).toEqual({
    observationOnly: true,
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

test('omits dispatch entirely when neither side carries options', () => {
  const request = maestroOperationDispatchRequest(
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
  const request = maestroOperationDispatchRequest(
    { token: 'token', session: 'session', command: 'replay', positionals: [] },
    { command: 'snapshot', positionals: [], dispatch: { observationOnly: true } },
  );

  expect(request.dispatch).toEqual({ observationOnly: true });
});

test('folds Maestro settings app targeting into dispatch', () => {
  const request = maestroOperationDispatchRequest(
    { token: 'token', session: 'session', command: 'replay', positionals: [] },
    {
      command: 'settings',
      positionals: ['permission', 'grant', 'camera'],
      dispatch: { settingsAppBundleId: 'com.example.app' },
    },
  );

  expect(request.dispatch).toEqual({ settingsAppBundleId: 'com.example.app' });
});

test('folds Maestro killApp targeting into dispatch', () => {
  const request = maestroOperationDispatchRequest(
    { token: 'token', session: 'session', command: 'replay', positionals: [] },
    {
      command: 'close',
      positionals: ['com.example.app'],
      dispatch: { closeAppOnly: true, killApp: true },
    },
  );

  expect(request.dispatch).toEqual({ closeAppOnly: true, killApp: true });
});

test('leaves dispatch options the operation does not set untouched', () => {
  const viewport = { x: 0, y: 0, width: 402, height: 874 };
  const request = maestroOperationDispatchRequest(
    {
      token: 'token',
      session: 'session',
      command: 'replay',
      positionals: [],
      dispatch: { replayPlanStep: true, gestureViewport: viewport },
    },
    { command: 'open', positionals: [], dispatch: { closeAppOnly: true } },
  );

  expect(request.dispatch).toEqual({
    replayPlanStep: true,
    gestureViewport: viewport,
    closeAppOnly: true,
  });
});
