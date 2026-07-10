import { RAW_COMMAND_DESCRIPTORS, type Command } from './registry.ts';

/**
 * Development-only owner-file navigation claims for every command (ADR 0008
 * follow-up, https://github.com/callstack/agent-device/issues/1178).
 *
 * These paths point a reader at the module that owns each command's surface so
 * `explain:command` can render "where does this live". They are pure tooling
 * metadata: nothing in the daemon/CLI runtime reads them, so they were removed
 * from the production {@link CommandDescriptor} objects (and therefore from the
 * emitted bundles) and kept as a derived view on the source-of-truth registry.
 *
 * The key space is the descriptor-derived {@link Command} union, so deriving the
 * projection from {@link RAW_COMMAND_DESCRIPTORS} makes a missing or misspelled
 * command a type error and forbids owner claims for commands that do not exist.
 * Only `command-explain.ts` and its tests import this module; the production
 * import graph never reaches it, so the bundler drops it entirely.
 */
type OwnerFilesFromDescriptors<
  T extends readonly {
    readonly name: string;
    readonly ownerFiles?: readonly [string, ...string[]];
  }[],
> = {
  [K in keyof T & number as T[K]['name']]: NonNullable<T[K]['ownerFiles']>;
};

const buildOwnerFiles = <
  const T extends readonly {
    readonly name: string;
    readonly ownerFiles?: readonly [string, ...string[]];
  }[],
>(
  entries: T,
): OwnerFilesFromDescriptors<T> =>
  Object.fromEntries(
    entries.map((entry) => [entry.name, entry.ownerFiles]),
  ) as OwnerFilesFromDescriptors<T>;

export const COMMAND_OWNER_FILES = buildOwnerFiles(RAW_COMMAND_DESCRIPTORS) satisfies Record<
  Command,
  readonly [string, ...string[]]
>;

/** The owner-file claims for one command (development-only navigation metadata). */
export function ownerFilesForCommand(command: Command): readonly [string, ...string[]] {
  return COMMAND_OWNER_FILES[command];
}
