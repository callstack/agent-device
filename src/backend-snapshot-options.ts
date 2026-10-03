import { snapshotFlagsFromOptions } from '@agent-device/kernel/snapshot';
import type { BackendSnapshotOptions } from './backend.ts';

type RoutedSnapshotOption = keyof Omit<BackendSnapshotOptions, 'includeRects' | 'outPath'>;

/**
 * Which backend snapshot options route as request flags. Still pinned to
 * `BackendSnapshotOptions`, so a new backend option must decide whether it
 * routes; the option→flag pairing itself is declared once in the kernel and is
 * no longer restated here.
 */
const ROUTED_SNAPSHOT_OPTIONS = {
  interactiveOnly: true,
  scope: true,
  depth: true,
  raw: true,
  customActions: true,
  includeHiddenContentHints: true,
  preferredBackend: true,
} as const satisfies Record<RoutedSnapshotOption, true>;

const ROUTED_SNAPSHOT_OPTION_KEYS = Object.keys(ROUTED_SNAPSHOT_OPTIONS) as ReadonlyArray<
  keyof typeof ROUTED_SNAPSHOT_OPTIONS
>;

export function snapshotOptionsToFlags(options: BackendSnapshotOptions | undefined) {
  return snapshotFlagsFromOptions(options, ROUTED_SNAPSHOT_OPTION_KEYS);
}
