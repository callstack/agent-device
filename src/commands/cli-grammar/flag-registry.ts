import { ACTION_FLAG_DEFINITIONS } from './flag-definitions-action.ts';
import { CONNECTION_FLAG_DEFINITIONS } from './flag-definitions-connection.ts';
import { TARGET_FLAG_DEFINITIONS } from './flag-definitions-target.ts';
import { WORKFLOW_FLAG_DEFINITIONS } from './flag-definitions-workflow.ts';
import type { FlagDefinition } from './flag-types.ts';

const FLAG_DEFINITIONS: readonly FlagDefinition[] = [
  ...CONNECTION_FLAG_DEFINITIONS,
  ...TARGET_FLAG_DEFINITIONS,
  ...ACTION_FLAG_DEFINITIONS,
  ...WORKFLOW_FLAG_DEFINITIONS,
];

const flagDefinitionByName = new Map<string, FlagDefinition>();
for (const definition of FLAG_DEFINITIONS) {
  for (const name of definition.names) flagDefinitionByName.set(name, definition);
}

export function getFlagDefinition(token: string): FlagDefinition | undefined {
  return flagDefinitionByName.get(token);
}

export function getFlagDefinitions(): readonly FlagDefinition[] {
  return FLAG_DEFINITIONS;
}
