import { commandDescriptors } from './command-descriptor/registry.ts';

export function commandRuntimeUseRequirements(
  command: string,
): readonly (readonly string[])[] | undefined {
  const descriptor = commandDescriptors.find((candidate) => candidate.name === command);
  const execution = descriptor?.platformExecution;
  if (execution?.kind !== 'device-runtime') return undefined;
  const uses = 'uses' in execution ? execution.uses : [execution.use];
  return uses.map((use) => use.required);
}

export function listRuntimeFactCommands(): string[] {
  return commandDescriptors
    .filter(
      (descriptor) =>
        descriptor.catalog.group === 'public' &&
        descriptor.platformExecution.kind === 'device-runtime',
    )
    .map((descriptor) => descriptor.name)
    .sort();
}
