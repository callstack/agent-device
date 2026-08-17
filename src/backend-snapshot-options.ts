import type { CommandFlags } from '@agent-device/contracts/command';
import type { BackendSnapshotOptions } from './backend.ts';

type RoutedSnapshotOption = keyof Omit<BackendSnapshotOptions, 'includeRects' | 'outPath'>;

const SNAPSHOT_OPTION_FLAGS = {
  interactiveOnly: 'snapshotInteractiveOnly',
  scope: 'snapshotScope',
  depth: 'snapshotDepth',
  raw: 'snapshotRaw',
  customActions: 'snapshotCustomActions',
  includeHiddenContentHints: 'snapshotIncludeHiddenContentHints',
  preferredBackend: 'snapshotPreferredBackend',
} as const satisfies Record<RoutedSnapshotOption, keyof CommandFlags>;

type SnapshotFlagOverrides = Partial<
  Pick<CommandFlags, (typeof SNAPSHOT_OPTION_FLAGS)[RoutedSnapshotOption]>
>;

export function snapshotOptionsToFlags(
  options: BackendSnapshotOptions | undefined,
): SnapshotFlagOverrides {
  if (!options) return {};
  return Object.fromEntries(
    Object.entries(SNAPSHOT_OPTION_FLAGS).flatMap(([optionKey, flagKey]) => {
      const value = options[optionKey as RoutedSnapshotOption];
      return value === undefined ? [] : [[flagKey, value]];
    }),
  ) as SnapshotFlagOverrides;
}
