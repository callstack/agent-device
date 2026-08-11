import {
  handleSessionCommands as handleProductionSessionCommands,
  type SessionCommandInput,
} from '../session.ts';

/** Unit-handler default is explicitly fail-closed; production must inject exact-owner recovery. */
export function handleSessionCommands(
  params: Omit<SessionCommandInput, 'reconcileOrphanedDeviceClaim'>,
): ReturnType<typeof handleProductionSessionCommands> {
  return handleProductionSessionCommands({
    ...params,
    reconcileOrphanedDeviceClaim: async () => ({
      status: 'retained',
      reason: 'test-harness-has-no-exact-owner-recovery',
    }),
  });
}
