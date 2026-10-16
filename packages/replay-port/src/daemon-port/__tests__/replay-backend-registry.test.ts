import { expect, test, vi } from 'vitest';
import { maestroReplayBackendDeclaration } from '@agent-device/maestro/replay-backend-declaration';
import { getReplayBackendDeclaration } from '../replay-backend-declarations.ts';
import { getReplayBackend } from '../replay-backend-registry.ts';

// The #3377 extraction seam: the registry is the only host-side door to a non-native engine, so
// what it promises is exactly what the plugin swap must keep — the load-once contract and the
// capability shape every host call site routes through.

test('lists the Maestro declaration for the maestro id', () => {
  expect(getReplayBackendDeclaration('maestro')).toBe(maestroReplayBackendDeclaration);
});

test('memoizes the backend so a process evaluates the engine once', async () => {
  const first = getReplayBackend('maestro');
  const second = getReplayBackend('maestro');
  expect(second).toBe(first);
  expect(await second).toBe(await first);
});

test('a backend carries every capability the host routes through it', async () => {
  const backend = await getReplayBackend('maestro');
  expect(backend.id).toBe('maestro');
  expect(Object.keys(backend).sort()).toEqual(
    ['collectSourceFiles', 'exportReplayScript', 'id', 'inspectSource', 'runReplay'].sort(),
  );
});

test('a failed load is not cached, so the next call retries it', async () => {
  // The mutation that makes this fail: without the registry's delete-on-rejection, the rejected
  // promise stays memoized and this second resolution rejects forever, where the pre-registry
  // per-call `import()` recovered from a one-off load failure. A fresh registry instance keeps
  // the memo map free of the successes above.
  vi.resetModules();
  let loadAttempts = 0;
  vi.doMock('@agent-device/maestro/replay-backend', () => ({
    // The loader reads the plugin export right after the `import()`, so failing the first read
    // fails the load exactly like a rejecting module evaluation would.
    get maestroReplayBackendPlugin() {
      loadAttempts += 1;
      if (loadAttempts === 1) throw new Error('transient load failure');
      return { create: () => ({ id: 'maestro' }) };
    },
  }));
  const { getReplayBackend: freshGet } = await import('../replay-backend-registry.ts');
  await expect(freshGet('maestro')).rejects.toThrow('transient load failure');
  await expect(freshGet('maestro')).resolves.toMatchObject({ id: 'maestro' });
  expect(loadAttempts).toBe(2);
  vi.doUnmock('@agent-device/maestro/replay-backend');
});
