import { expect, test } from 'vitest';
import { getReplayBackend } from '../replay-backend-registry.ts';
import { maestroBackend } from '../replay-maestro-backend.ts';

// The #3377 extraction seam: the registry is the only host-side door to a non-native engine, so
// what it promises is exactly what the plugin swap must keep — the load-once contract and the
// capability shape every host call site routes through.

test('resolves the Maestro backend through its registration', async () => {
  await expect(getReplayBackend('maestro')).resolves.toBe(maestroBackend);
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
