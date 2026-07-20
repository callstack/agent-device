import type { CommandName } from '../commands/command-metadata.ts';
import type { CommandExecutionResult } from '../commands/command-surface.ts';
import { serializeDevice } from '../contracts/result-serialization.ts';

type CollectionCommandName = {
  [Name in CommandName]: CommandExecutionResult<Name> extends readonly unknown[] ? Name : never;
}[CommandName];

type CollectionResultProjectors = {
  [Name in CollectionCommandName]: (
    result: CommandExecutionResult<Name>,
  ) => Record<string, unknown>;
};

type NonCollectionCommandName = Exclude<CommandName, CollectionCommandName>;
type NonObjectCommandName = {
  [Name in NonCollectionCommandName]: CommandExecutionResult<Name> extends object ? never : Name;
}[NonCollectionCommandName];

const COLLECTION_RESULT_PROJECTORS = {
  devices: (devices: CommandExecutionResult<'devices'>) => ({
    devices: devices.map(serializeDevice),
  }),
  apps: (apps: CommandExecutionResult<'apps'>) => ({ apps }),
} satisfies CollectionResultProjectors & Record<NonObjectCommandName, never>;

export function projectStructuredContent(
  name: CommandName,
  result: CommandExecutionResult,
): Record<string, unknown> {
  // Command execution preserves name/result correlation, but a dynamic lookup
  // cannot express it to TypeScript. This is the single re-correlation seam.
  const projector = COLLECTION_RESULT_PROJECTORS[name as CollectionCommandName] as
    | ((value: CommandExecutionResult) => Record<string, unknown>)
    | undefined;
  if (projector) return projector(result);
  return result as Record<string, unknown>;
}
