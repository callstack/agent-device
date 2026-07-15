import { isScalar, type Node } from 'yaml';
import type {
  MaestroCommand,
  MaestroPlatform,
  MaestroRepeatCommand,
  MaestroRetryCommand,
  MaestroRunFlowCommand,
  MaestroRunFlowCondition,
  MaestroRunScriptCommand,
} from './program-ir.ts';
import {
  assertOnlyKeys,
  entryValue,
  hasEntry,
  invalidAt,
  readIntegerValue,
  readMapEntries,
  readOptionalString,
  readOptionalEntry,
  readRequiredString,
  readScalarMap,
  readScalarValue,
  sourceAt,
  type MaestroProgramParseContext,
} from './program-ir-values.ts';
import { parseMaestroSelector } from './program-ir-gesture-parser.ts';
import { stripUndefined } from '../../utils/parsing.ts';

export type MaestroCommandListParser = (
  node: Node | null | undefined,
  name: string,
  context: MaestroProgramParseContext,
) => MaestroCommand[];

export function parseMaestroRunScriptCommand(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
): MaestroRunScriptCommand {
  const source = sourceAt(commandNode, context);
  if (isScalar(value)) {
    return {
      kind: 'runScript',
      source,
      file: readRequiredString(value, 'runScript', context),
    };
  }
  const entries = readMapEntries(value, 'runScript', context);
  assertOnlyKeys(entries, 'runScript', ['file', 'env'], context);
  if (!hasEntry(entries, 'file'))
    invalidAt('Maestro runScript requires a file.', commandNode, context);
  const file = readRequiredString(entryValue(entries, 'file'), 'runScript.file', context);
  const env = hasEntry(entries, 'env')
    ? readScalarMap(entryValue(entries, 'env'), 'runScript.env', context)
    : undefined;
  return stripUndefined({
    kind: 'runScript' as const,
    source,
    file,
    env,
  });
}

export function parseMaestroRunFlowCommand(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
  parseCommands: MaestroCommandListParser,
): MaestroRunFlowCommand {
  const source = sourceAt(commandNode, context);
  if (isScalar(value)) {
    return {
      kind: 'runFlow',
      source,
      include: {
        kind: 'file',
        path: readRequiredString(value, 'runFlow', context),
      },
    };
  }

  const entries = readMapEntries(value, 'runFlow', context);
  assertOnlyKeys(entries, 'runFlow', ['file', 'commands', 'env', 'when', 'label'], context);
  const hasFile = hasEntry(entries, 'file');
  const hasCommands = hasEntry(entries, 'commands');
  if (hasFile === hasCommands) {
    invalidAt('Maestro runFlow requires exactly one of file or commands.', commandNode, context);
  }
  const include = hasFile
    ? {
        kind: 'file' as const,
        path: readRequiredString(entryValue(entries, 'file'), 'runFlow.file', context),
      }
    : {
        kind: 'commands' as const,
        commands: parseCommands(entryValue(entries, 'commands'), 'runFlow.commands', context),
      };
  const env = hasEntry(entries, 'env')
    ? readScalarMap(entryValue(entries, 'env'), 'runFlow.env', context)
    : undefined;
  const when = hasEntry(entries, 'when')
    ? parseMaestroRunFlowCondition(entryValue(entries, 'when'), context)
    : undefined;
  const label = hasEntry(entries, 'label')
    ? readOptionalString(entryValue(entries, 'label'), 'runFlow.label', context)
    : undefined;
  return stripUndefined({
    kind: 'runFlow' as const,
    source,
    include,
    env,
    when,
    label,
  });
}

export function parseMaestroRepeatCommand(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
  parseCommands: MaestroCommandListParser,
): MaestroRepeatCommand {
  const source = sourceAt(commandNode, context);
  const entries = readMapEntries(value, 'repeat', context);
  assertOnlyKeys(entries, 'repeat', ['times', 'commands', 'while'], context);
  if (hasEntry(entries, 'while')) {
    invalidAt(
      'Maestro repeat.while is not supported; use repeat.times.',
      entryValue(entries, 'while'),
      context,
    );
  }
  if (!hasEntry(entries, 'times'))
    invalidAt('Maestro repeat requires times.', commandNode, context);
  if (!hasEntry(entries, 'commands'))
    invalidAt('Maestro repeat requires commands.', commandNode, context);
  return {
    kind: 'repeat',
    source,
    times: readIntegerValue(entryValue(entries, 'times'), 'repeat.times', context),
    commands: parseCommands(entryValue(entries, 'commands'), 'repeat.commands', context),
  };
}

export function parseMaestroRetryCommand(
  value: Node | null,
  commandNode: Node,
  context: MaestroProgramParseContext,
  parseCommands: MaestroCommandListParser,
): MaestroRetryCommand {
  const source = sourceAt(commandNode, context);
  const entries = readMapEntries(value, 'retry', context);
  assertOnlyKeys(entries, 'retry', ['maxRetries', 'commands'], context);
  if (!hasEntry(entries, 'commands'))
    invalidAt('Maestro retry requires commands.', commandNode, context);
  const maxRetries = hasEntry(entries, 'maxRetries')
    ? readIntegerValue(entryValue(entries, 'maxRetries'), 'retry.maxRetries', context)
    : undefined;
  return stripUndefined({
    kind: 'retry' as const,
    source,
    commands: parseCommands(entryValue(entries, 'commands'), 'retry.commands', context),
    maxRetries,
  });
}

function parseMaestroRunFlowCondition(
  node: Node | null | undefined,
  context: MaestroProgramParseContext,
): MaestroRunFlowCondition {
  const entries = readMapEntries(node, 'runFlow.when', context);
  assertOnlyKeys(entries, 'runFlow.when', ['platform', 'visible', 'notVisible', 'true'], context);
  if (entries.length === 0) invalidAt('Maestro runFlow.when cannot be empty.', node, context);

  const platform = readOptionalEntry(entries, 'platform', (entry) => parsePlatform(entry, context));
  const visible = readOptionalEntry(entries, 'visible', (entry) =>
    parseMaestroSelector(entry, 'runFlow.when.visible', context),
  );
  const notVisible = readOptionalEntry(entries, 'notVisible', (entry) =>
    parseMaestroSelector(entry, 'runFlow.when.notVisible', context),
  );
  const truth = readOptionalEntry(entries, 'true', (entry) => readConditionTruth(entry, context));
  return stripUndefined({ platform, visible, notVisible, true: truth });
}

function readConditionTruth(
  node: Node | null | undefined,
  context: MaestroProgramParseContext,
): boolean | string {
  const value = readScalarValue(node, 'runFlow.when.true', context);
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  invalidAt('Maestro runFlow.when.true expects a boolean or expression string.', node, context);
}

function parsePlatform(
  node: Node | null | undefined,
  context: MaestroProgramParseContext,
): MaestroPlatform {
  const value = readRequiredString(node, 'runFlow.when.platform', context).toLowerCase();
  if (value === 'android' || value === 'ios' || value === 'web') return value;
  invalidAt('Maestro runFlow.when.platform expects Android, iOS, or Web.', node, context);
}
