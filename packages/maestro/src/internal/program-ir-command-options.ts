import {
  readOptionalEntry,
  readOptionalString,
  type MaestroMapEntry,
  type MaestroProgramParseContext,
} from './program-ir-values.ts';

/** Read Maestro's outer command description without giving it selector meaning. */
export function readMaestroCommandLabel(
  entries: readonly MaestroMapEntry[],
  commandName: string,
  context: MaestroProgramParseContext,
): string | undefined {
  return readOptionalEntry(entries, 'label', (entry) =>
    readOptionalString(entry, `${commandName}.label`, context),
  );
}
