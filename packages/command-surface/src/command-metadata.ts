import { listMcpExposedCommandNames } from '@agent-device/command-registry/registry';
import type { CommandMetadata } from './command-contract.ts';
import { COMMON_INPUT_KEYS } from './common-input-fields.ts';
import { listCommandFamilyMetadata, type CommandFamilyCommandName } from './family/registry.ts';

export type CommandName = CommandFamilyCommandName;

type AnyCommandMetadata = CommandMetadata<CommandName, unknown>;

const commandMetadata = listCommandFamilyMetadata();

const commandMetadataMap: ReadonlyMap<CommandName, AnyCommandMetadata> = new Map(
  commandMetadata.map((definition) => [definition.name, definition]),
);

export function listCommandMetadata(): AnyCommandMetadata[] {
  return [...commandMetadata];
}

export function listMcpCommandMetadata(): AnyCommandMetadata[] {
  return listMcpExposedCommandNames().map((name) => {
    const metadata = findCommandMetadata(name);
    if (!metadata) {
      throw new Error(`Missing command metadata for MCP-exposed command: ${name}`);
    }
    return metadata;
  });
}

/**
 * @internal Introspection helper used by command surface parity tests.
 */
export function listCommandMetadataNames(): CommandName[] {
  return [...commandMetadataMap.keys()].sort();
}

export function isCommandName(name: string): name is CommandName {
  return commandMetadataMap.has(name as CommandName);
}

export function findCommandMetadata(name: CommandName): AnyCommandMetadata;
export function findCommandMetadata(name: string): AnyCommandMetadata | undefined;
export function findCommandMetadata(name: string): AnyCommandMetadata | undefined {
  return commandMetadataMap.get(name as CommandName);
}

/**
 * The structured input keys a command's own reader recognizes: its field map
 * (the advertised properties, plus the retired and alias keys the schema
 * excludes but the reader still answers for) and the shared common table. The
 * batch step readers that sit outside the family registry's own import
 * subtree pass this set to the step input's unknown-key refusal, so that
 * refusal names the closest key the step could actually carry instead of
 * dropping an unknown one silently.
 */
export function commandInputKeys(command: string): readonly string[] {
  const metadata = findCommandMetadata(command);
  if (!metadata) {
    throw new Error(`Missing command metadata for command: ${command}`);
  }
  return [
    ...new Set([
      ...Object.keys(metadata.inputSchema.properties ?? {}),
      ...Object.keys(metadata.inputAudience),
      ...COMMON_INPUT_KEYS,
    ]),
  ];
}
