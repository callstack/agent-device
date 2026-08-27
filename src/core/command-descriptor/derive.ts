import type { DaemonCommandDescriptor } from '../../daemon/daemon-command-registry.ts';
import type { CommandDescriptor } from './types.ts';

/**
 * Pure folds that project live command tables from the
 * {@link CommandDescriptor} registry. These started as parity-test helpers and
 * are now the production derivation path for descriptor-owned views.
 */

/** Reconstructs the DAEMON_COMMAND_DESCRIPTORS array (same order, same shape). */
export function deriveDaemonCommandDescriptors(
  descriptors: readonly CommandDescriptor[],
): DaemonCommandDescriptor[] {
  const result: DaemonCommandDescriptor[] = [];
  for (const descriptor of descriptors) {
    if (!descriptor.daemon) continue;
    result.push({
      command: descriptor.name,
      ...descriptor.daemon,
      replayScopedAction: descriptor.recordsSessionAction,
    });
  }
  return result;
}

/** Reconstructs the STRUCTURED_BATCH_COMMAND_NAMES membership. */
export function deriveStructuredBatchCommandNames(
  descriptors: readonly CommandDescriptor[],
): string[] {
  return descriptors
    .filter((descriptor) => descriptor.batchable)
    .map((descriptor) => descriptor.name);
}
