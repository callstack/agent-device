import { isMap, isSeq, LineCounter, parseAllDocuments, type Node } from 'yaml';
import { AppError } from '../../kernel/errors.ts';
import type {
  MaestroProgram,
  MaestroProgramConfig,
  MaestroProgramParseOptions,
} from './program-ir.ts';
import { parseMaestroCommandList } from './program-ir-command-parser.ts';
import {
  assertOnlyKeys,
  entryValue,
  hasEntry,
  invalidAt,
  readMapEntries,
  readOptionalString,
  readScalarMap,
  sourceAt,
  type MaestroProgramParseContext,
} from './program-ir-values.ts';

export function parseMaestroProgram(
  script: string,
  options: MaestroProgramParseOptions = {},
): MaestroProgram {
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(script, { lineCounter });
  for (const document of documents) {
    if (document.errors.length > 0) {
      const message = document.errors[0]?.message ?? 'Invalid Maestro YAML flow.';
      throw new AppError('INVALID_ARGS', `Invalid Maestro YAML flow: ${message}`);
    }
  }

  const context: MaestroProgramParseContext = {
    lineCounter,
    ...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath }),
  };
  const contents = documents.map((document) => document.contents).filter((value) => value !== null);
  if (contents.length === 0) throw new AppError('INVALID_ARGS', 'Maestro flow is empty.');

  let configNode: Node | undefined;
  let commandsNode: Node | undefined;
  if (contents.length === 1 && isSeq(contents[0])) {
    commandsNode = contents[0];
  } else if (contents.length === 2 && isMap(contents[0]) && isSeq(contents[1])) {
    configNode = contents[0];
    commandsNode = contents[1];
  } else {
    invalidAt(
      'Maestro flow must contain a command list, optionally preceded by one config document.',
      contents[0],
      context,
    );
  }

  const config = configNode ? parseProgramConfig(configNode, context) : {};
  return {
    kind: 'program',
    source: sourceAt(configNode ?? commandsNode, context),
    config,
    commands: parseMaestroCommandList(commandsNode, 'commands', context),
  };
}

function parseProgramConfig(node: Node, context: MaestroProgramParseContext): MaestroProgramConfig {
  const entries = readMapEntries(node, 'flow config', context);
  assertOnlyKeys(
    entries,
    'flow config',
    ['name', 'appId', 'env', 'onFlowStart', 'onFlowComplete'],
    context,
  );
  const name = hasEntry(entries, 'name')
    ? readOptionalString(entryValue(entries, 'name'), 'name', context)
    : undefined;
  const appId = hasEntry(entries, 'appId')
    ? readOptionalString(entryValue(entries, 'appId'), 'appId', context)
    : undefined;
  const env = hasEntry(entries, 'env')
    ? readScalarMap(entryValue(entries, 'env'), 'env', context)
    : undefined;
  const onFlowStart = hasEntry(entries, 'onFlowStart')
    ? parseMaestroCommandList(entryValue(entries, 'onFlowStart'), 'onFlowStart', context)
    : undefined;
  const onFlowComplete = hasEntry(entries, 'onFlowComplete')
    ? parseMaestroCommandList(entryValue(entries, 'onFlowComplete'), 'onFlowComplete', context)
    : undefined;
  return {
    ...(name === undefined ? {} : { name }),
    ...(appId === undefined ? {} : { appId }),
    ...(env === undefined ? {} : { env }),
    ...(onFlowStart === undefined ? {} : { onFlowStart }),
    ...(onFlowComplete === undefined ? {} : { onFlowComplete }),
  };
}
