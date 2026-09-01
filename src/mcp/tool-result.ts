import type { CommandName } from '../commands/command-metadata.ts';
import type { CommandExecutionResult } from '../commands/command-surface.ts';

type CollectionCommandName = {
  [Name in CommandName]: CommandExecutionResult<Name> extends readonly unknown[] ? Name : never;
}[CommandName];

type CollectionResultProjectors = {
  [Name in CollectionCommandName]: (
    result: CommandExecutionResult<Name>,
  ) => Promise<Record<string, unknown>>;
};

type NonCollectionCommandName = Exclude<CommandName, CollectionCommandName>;
type NonObjectCommandName = {
  [Name in NonCollectionCommandName]: CommandExecutionResult<Name> extends object ? never : Name;
}[NonCollectionCommandName];

const COLLECTION_RESULT_PROJECTORS = {
  devices: async (devices: CommandExecutionResult<'devices'>) => {
    const { serializeDevice } = await import('../daemon/result-serialization.ts');
    return { devices: devices.map(serializeDevice) };
  },
  apps: async (apps: CommandExecutionResult<'apps'>) => ({ apps }),
} satisfies CollectionResultProjectors & Record<NonObjectCommandName, never>;

export async function projectStructuredContent(
  name: CommandName,
  result: CommandExecutionResult,
): Promise<Record<string, unknown>> {
  // Command execution preserves name/result correlation, but a dynamic lookup
  // cannot express it to TypeScript. This is the single re-correlation seam.
  const projector = COLLECTION_RESULT_PROJECTORS[name as CollectionCommandName] as
    | ((value: CommandExecutionResult) => Promise<Record<string, unknown>>)
    | undefined;
  if (projector) return await projector(result);
  return result as Record<string, unknown>;
}
