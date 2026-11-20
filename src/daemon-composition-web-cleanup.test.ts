import { expect, test, vi } from 'vitest';
import { createDaemonStartupWebOrphanCleanup } from './daemon-composition.ts';
import { webSelectionFixture } from './platform-runtime-web-provider.fixtures.ts';

test('daemon startup passes open web sessions to the selected platform cleanup', async () => {
  const active = webSelectionFixture().get();
  const cleanupOrphans = vi.fn(async (_sessions: readonly string[]) => {});
  const registration = { ...active, operations: { ...active.operations, cleanupOrphans } };
  const cleanup = createDaemonStartupWebOrphanCleanup({
    active: registration,
    get: () => registration,
  });
  await cleanup({ stateDir: '/fixture-state', openWebSessionNames: ['web-session'] });
  expect(cleanupOrphans).toHaveBeenCalledExactlyOnceWith(['web-session']);
});
