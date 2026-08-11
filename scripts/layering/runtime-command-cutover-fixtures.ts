import { checkRuntimeCommandCutover } from './runtime-command-cutover-policy.ts';
import { MIGRATED_COMMAND_CUTOVERS } from './runtime-command-cutover-table.ts';
import type { MigratedCommandCutover } from './runtime-command-cutover-model.ts';

export type SourceEntry = readonly [path: string, source: string];

export function sources(entries: readonly SourceEntry[]): ReadonlyMap<string, string> {
  return new Map(entries);
}

/** The migrated rows share one scan, so per-row assertions read their own rule's output. */
export function summariesFor(
  rule: string,
  entries: readonly SourceEntry[],
  table: readonly MigratedCommandCutover[] = MIGRATED_COMMAND_CUTOVERS,
): string[] {
  return checkRuntimeCommandCutover(sources(entries), table)
    .filter((violation) => violation.rule === rule)
    .map(({ file, message }) => `${file}: ${message}`);
}

export function rowFor(command: string): MigratedCommandCutover {
  const row = MIGRATED_COMMAND_CUTOVERS.find((candidate) => candidate.command === command);
  if (row === undefined) throw new Error(`no cutover row for ${command}`);
  return row;
}

/**
 * A row for a command that does not exist, so the mechanism can be exercised without
 * the real table's rows reacting to the planted sources.
 */
export const PLANTED_ROW: MigratedCommandCutover = {
  rule: 'RPlanted planted-cutover',
  command: 'planted',
  subject: 'planted',
  tier: 'request-scoped',
  execution: 'device-runtime',
  legacyRetirement: {
    modulePaths: ['src/daemon/planted-legacy.ts'],
    importPatterns: [/(?:^|\/)planted-legacy(?:\.[cm]?[jt]s)?$/],
    routeNames: ['resolvePlantedBackend'],
    pluginFacetKeys: ['planted'],
  },
  admissionMember: {
    forms: ['computed-property'],
    message: 'Apple plugin retains legacy planted support or hint closure',
  },
  runtimeTypeNames: ['PlantedRuntimeOperations'],
  operations: { names: ['plantedDump'] },
  singularExecution: {
    routes: ['handlePlantedCommand'],
    operations: ['plantedDump'],
    operationOwners: { plantedDump: ['handlePlantedCommand'] },
  },
};
