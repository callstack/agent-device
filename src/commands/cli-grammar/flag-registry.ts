import { ACTION_FLAG_DEFINITIONS } from './flag-definitions-action.ts';
import { CONNECTION_FLAG_DEFINITIONS } from './flag-definitions-connection.ts';
import { TARGET_FLAG_DEFINITIONS } from './flag-definitions-target.ts';
import { WORKFLOW_FLAG_DEFINITIONS } from './flag-definitions-workflow.ts';
import type {
  FlagDefinition,
  FlagKey,
  RecordableFlagDefinition,
  RecordableFlagKey,
} from './flag-types.ts';

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

/**
 * The declarations for one flag key. A key can hold more than one when its CLI
 * spelling is a `setValue` pair (`--record` / `--no-record`), so the caller
 * decides which facet it needs.
 */
export function getFlagDefinitionsForKey(key: FlagKey): readonly FlagDefinition[] {
  return FLAG_DEFINITIONS.filter((definition) => definition.key === key);
}

/**
 * The keys a project `agent-device.json` may set, derived from each declaration's
 * `projectConfig` field. Recomputed per call over the live declarations rather than
 * cached here, so a consumer that builds its admission set at its own module load
 * observes the current declarations — which is what lets a planted declaration move
 * the surface a divergence test reads.
 */
export function projectConfigFlagKeys(): ReadonlySet<FlagKey> {
  return new Set(
    FLAG_DEFINITIONS.filter((definition) => definition.projectConfig).map(
      (definition) => definition.key,
    ),
  );
}

/**
 * The keys the session recorder copies into `SessionAction.flags`, derived from each
 * declaration's `recorded` field. Recomputed per call for the same reason as
 * `projectConfigFlagKeys`. A `recorded: true` declaration can only exist for a
 * `RecordableFlagKey` (the type forbids it otherwise), so the filter narrows to
 * keys the recorder can index on `CommandFlags`.
 */
export function recordedFlagKeys(): ReadonlySet<RecordableFlagKey> {
  return new Set(
    FLAG_DEFINITIONS.filter(
      (definition): definition is RecordableFlagDefinition => definition.recorded,
    ).map((definition) => definition.key),
  );
}
