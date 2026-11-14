import assert from 'node:assert/strict';
import { beforeEach, expect, test, vi } from 'vitest';
import type { ReplayBackendHost } from '@agent-device/contracts/replay-backend';
import type { retainPngWorker } from '@agent-device/capture-kit/png-worker-client';

const state = vi.hoisted(() => ({
  engineLoads: 0,
  retain: vi.fn<typeof retainPngWorker>(),
}));

vi.mock('./replay-backend/replay-maestro-backend.ts', async (importOriginal) => {
  state.engineLoads += 1;
  return await importOriginal<typeof import('./replay-backend/replay-maestro-backend.ts')>();
});

vi.mock('@agent-device/capture-kit/png-worker-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/capture-kit/png-worker-client')>()),
  retainPngWorker: state.retain,
}));

const setupHost = {
  env: {},
  options: {},
  clientVersion: '0.22.0-dev',
  createError: () => {
    throw new Error('setup must not use host services');
  },
};

beforeEach(() => {
  vi.resetModules();
  state.engineLoads = 0;
  state.retain.mockReset();
});

test('factory setup and unused disposal leave the engine and PNG worker unloaded', async () => {
  const { default: maestroPlugin } = await import('./plugin.ts');
  const plugin = maestroPlugin();
  expect({ apiVersion: plugin.apiVersion, kind: plugin.kind, backend: plugin.backend }).toEqual({
    apiVersion: 2,
    kind: 'replay-backend',
    backend: 'maestro',
  });

  const setup = await plugin.setup(setupHost);
  await setup.dispose?.();

  expect(state.engineLoads).toBe(0);
  expect(state.retain).not.toHaveBeenCalled();
});

test('selected creation retains one worker, forwards its diagnostic to the host and releases it', async () => {
  const sinks: Parameters<typeof retainPngWorker>[0][] = [];
  const release = vi.fn(async () => {});
  state.retain.mockImplementation((sink) => {
    sinks.push(sink);
    return release;
  });
  const host: ReplayBackendHost = {
    emitDiagnostic: vi.fn(),
    appendTraceEvent: () => {
      throw new Error('trace unused');
    },
    buildBuiltinVars: () => {
      throw new Error('variables unused');
    },
    readScriptSourceFile: () => {
      throw new Error('source reader unused');
    },
    scriptSourceRequiredMessage: '',
    resolveTargetDevice: () => Promise.reject(new Error('device selection unused')),
    requestSignal: () => undefined,
    buildActionFailureResponse: () => Promise.reject(new Error('failure response unused')),
  };
  const { default: maestroPlugin } = await import('./plugin.ts');
  const setup = await maestroPlugin().setup(setupHost);
  const backend = await setup.replayBackend.create(host);
  const nextBackend = await setup.replayBackend.create(host);

  expect(state.engineLoads).toBe(1);
  expect(backend.id).toBe('maestro');
  expect(
    nextBackend.inspectSource(
      'appId: com.example.app\nname: Checkout\n---\n- launchApp',
      '/flow.yaml',
    ),
  ).toEqual({ title: 'Checkout', appTarget: 'com.example.app' });
  expect(state.retain).toHaveBeenCalledTimes(1);
  expect(release).not.toHaveBeenCalled();

  const reason = { kind: 'worker-exited', detail: 'exit code 1' } as const;
  const onUnavailable = sinks[0];
  assert.ok(onUnavailable);
  onUnavailable(reason);
  expect(host.emitDiagnostic).toHaveBeenCalledExactlyOnceWith({
    level: 'warn',
    phase: 'png_worker_unavailable',
    data: reason,
  });

  await setup.dispose?.();
  expect(release).toHaveBeenCalledTimes(1);
});
