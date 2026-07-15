import { isMap, isSeq, LineCounter, parseAllDocuments, type Node } from 'yaml';
import { AppError } from '../../kernel/errors.ts';
import { stripUndefined } from '../../utils/parsing.ts';
import type {
  MaestroProgram,
  MaestroProgramConfig,
  MaestroProgramParseOptions,
} from './program-ir.ts';
import { parseMaestroCommandList } from './program-ir-command-parser.ts';
import {
  assertOnlyKeys,
  formatSourceLocation,
  invalidAt,
  readMapEntries,
  readOptionalString,
  readOptionalEntry,
  readScalarMap,
  readStringSequence,
  sourceAt,
  sourceAtOffset,
  type MaestroProgramParseContext,
} from './program-ir-values.ts';

export function parseMaestroProgram(
  script: string,
  options: MaestroProgramParseOptions = {},
): MaestroProgram {
  const lineCounter = new LineCounter();
  const context: MaestroProgramParseContext = stripUndefined({
    lineCounter,
    sourcePath: options.sourcePath,
  });
  const documents = parseAllDocuments(script, { lineCounter });
  for (const document of documents) {
    if (document.errors.length > 0) {
      const error = document.errors[0];
      const message = error?.message ?? 'Invalid Maestro YAML flow.';
      const source = sourceAtOffset(error?.pos[0], context);
      throw new AppError(
        'INVALID_ARGS',
        `Invalid Maestro YAML flow: ${message} (${formatSourceLocation(source)})`,
      );
    }
  }

  const contents = documents.map((document) => document.contents).filter((value) => value !== null);
  if (contents.length === 0) invalidAt('Maestro flow is empty.', undefined, context);

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
    ['name', 'appId', 'tags', 'env', 'onFlowStart', 'onFlowComplete'],
    context,
  );
  const name = readOptionalEntry(entries, 'name', (entry) =>
    readOptionalString(entry, 'name', context),
  );
  const appId = readOptionalEntry(entries, 'appId', (entry) =>
    readOptionalString(entry, 'appId', context),
  );
  const tags = readOptionalEntry(entries, 'tags', (entry) =>
    readStringSequence(entry, 'tags', context),
  );
  const env = readOptionalEntry(entries, 'env', (entry) => readScalarMap(entry, 'env', context));
  const onFlowStart = readOptionalEntry(entries, 'onFlowStart', (entry) =>
    parseMaestroCommandList(entry, 'onFlowStart', context),
  );
  const onFlowComplete = readOptionalEntry(entries, 'onFlowComplete', (entry) =>
    parseMaestroCommandList(entry, 'onFlowComplete', context),
  );
  return stripUndefined({ name, appId, tags, env, onFlowStart, onFlowComplete });
}
