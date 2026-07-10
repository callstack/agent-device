import fs from 'node:fs';
import path from 'node:path';
import type { SessionAction } from '../../daemon/types.ts';
import { AppError } from '../../kernel/errors.ts';
import { convertMaestroCommandWithLine } from './command-mapper.ts';
import { parseMaestroYamlDocuments } from './flow-yaml.ts';
import { MAESTRO_RUNTIME_COMMAND } from './runtime-commands.ts';
import { isPlainRecord, normalizeCommandList, normalizePlatform, readEnvMap } from './support.ts';
import type {
  MaestroCommand,
  MaestroFlowConfig,
  MaestroParseContext,
  MaestroParseOptions,
  MaestroReplayFlow,
} from './types.ts';

export function parseMaestroReplayFlow(
  script: string,
  options: MaestroParseOptions = {},
): MaestroReplayFlow {
  return parseMaestroReplayFlowInternal(script, createParseContext(options));
}

export function readMaestroFlowName(script: string): string | undefined {
  const values = parseMaestroYamlDocuments(script);
  const { config } = splitMaestroDocuments(values);
  return config.name;
}

function parseMaestroReplayFlowInternal(
  script: string,
  context: MaestroParseContext,
): MaestroReplayFlow {
  const values = parseMaestroYamlDocuments(script);
  const { config, commands } = splitMaestroDocuments(values);
  const nextContext = {
    ...context,
    env: { ...context.env, ...(config.env ?? {}), ...context.envOverrides },
  };
  const commandLines = findMaestroCommandLines(script);
  const { actions, actionLines, actionSourcePaths } = convertRootCommands({
    config,
    commands,
    commandLines,
    context: nextContext,
  });

  return {
    actions,
    actionLines,
    actionSourcePaths,
    metadata: {
      env: config.env,
    },
  };
}

type ConvertedFlowActions = {
  actions: SessionAction[];
  actionLines: number[];
  actionSourcePaths: (string | undefined)[];
};

function convertRootCommands(params: {
  config: MaestroFlowConfig;
  commands: MaestroCommand[];
  commandLines: number[];
  context: MaestroParseContext;
}): ConvertedFlowActions {
  const { config, commands, commandLines, context } = params;
  const allCommands = [
    ...(config.onFlowStart ?? []),
    ...commands,
    ...(config.onFlowComplete ?? []),
  ];
  const allCommandLines = buildRootCommandLines(config, commandLines);

  const actions: SessionAction[] = [];
  const actionLines: number[] = [];
  const actionSourcePaths: (string | undefined)[] = [];
  for (const [index, command] of allCommands.entries()) {
    const line = allCommandLines[index] ?? index + 1;
    const converted = convertMaestroCommandWithLine(command, config, line, context, {
      parseRunFlowFile,
    });
    for (const [actionIndex, action] of converted.actions.entries()) {
      const source = converted.sources[actionIndex];
      actions.push(action);
      actionLines.push(source?.line ?? line);
      actionSourcePaths.push(source?.path);
    }
  }
  return optimizeInputTextActions(actions, actionLines, actionSourcePaths);
}

/** `onFlowStart` commands report line 1; `onFlowComplete` commands report the script's last command line — both hooks live outside the numbered command list. */
function buildRootCommandLines(config: MaestroFlowConfig, commandLines: number[]): number[] {
  return [
    ...Array.from({ length: config.onFlowStart?.length ?? 0 }, () => 1),
    ...commandLines,
    ...Array.from({ length: config.onFlowComplete?.length ?? 0 }, () => commandLines.at(-1) ?? 1),
  ];
}

function optimizeInputTextActions(
  actions: SessionAction[],
  actionLines: number[],
  actionSourcePaths: (string | undefined)[],
): ConvertedFlowActions {
  const mergedActions: SessionAction[] = [];
  const mergedLines: number[] = [];
  const mergedSourcePaths: (string | undefined)[] = [];
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!;
    const optimized = optimizeTypedAfterTap(actions, actionLines, actionSourcePaths, index);
    if (optimized) {
      mergedActions.push(...optimized.actions);
      mergedLines.push(...optimized.actionLines);
      mergedSourcePaths.push(...optimized.actionSourcePaths);
      index += optimized.consumed - 1;
      continue;
    }
    mergedActions.push(action);
    mergedLines.push(actionLines[index] ?? 1);
    mergedSourcePaths.push(actionSourcePaths[index]);
  }
  return { actions: mergedActions, actionLines: mergedLines, actionSourcePaths: mergedSourcePaths };
}

function optimizeTypedAfterTap(
  actions: SessionAction[],
  actionLines: number[],
  actionSourcePaths: (string | undefined)[],
  index: number,
): (ConvertedFlowActions & { consumed: number }) | null {
  const candidate = readTypedAfterTapCandidate(actions, actionLines, index);
  if (!candidate) return null;
  const { action, nextAction, pressEnterAction, tapSelector, typedAfterTap, line } = candidate;
  const sourcePath = actionSourcePaths[index];
  if (!isLikelyTextEntrySelector(tapSelector)) {
    return {
      actions: [clearMaestroNonHittableTap(action)],
      actionLines: [line],
      actionSourcePaths: [sourcePath],
      consumed: 1,
    };
  }
  return {
    actions: [
      {
        ...action,
        command: 'wait',
        positionals: [tapSelector, '30000'],
      },
      {
        ...nextAction,
        command: 'fill',
        positionals: [tapSelector, typedAfterTap],
        flags: action.flags,
      },
      pressEnterAction,
    ],
    actionLines: [line, line, actionLines[index + 2] ?? line],
    actionSourcePaths: [sourcePath, sourcePath, actionSourcePaths[index + 2]],
    consumed: 3,
  };
}

function readTypedAfterTapCandidate(
  actions: SessionAction[],
  actionLines: number[],
  index: number,
): {
  action: SessionAction;
  nextAction: SessionAction;
  pressEnterAction: SessionAction;
  tapSelector: string;
  typedAfterTap: string;
  line: number;
} | null {
  const action = actions[index]!;
  const nextAction = actions[index + 1];
  const pressEnterAction = actions[index + 2];
  if (pressEnterAction?.command !== MAESTRO_RUNTIME_COMMAND.pressEnter) return null;
  if (action.flags?.maestro?.optional === true) return null;
  const typedAfterTap = readPlainTypeText(nextAction);
  const tapSelector = readPlainMaestroTapSelector(action);
  if (!nextAction || typedAfterTap === null || tapSelector === null) return null;
  return {
    action,
    nextAction,
    pressEnterAction,
    tapSelector,
    typedAfterTap,
    line: actionLines[index] ?? 1,
  };
}

function clearMaestroNonHittableTap(action: SessionAction): SessionAction {
  const maestro = { ...(action.flags?.maestro ?? {}) };
  delete maestro.allowNonHittableCoordinateFallback;
  return {
    ...action,
    flags: {
      ...(action.flags ?? {}),
      maestro: {
        ...maestro,
      },
    },
  };
}

function readPlainMaestroTapSelector(action: SessionAction | undefined): string | null {
  if (action?.command !== MAESTRO_RUNTIME_COMMAND.tapOn) return null;
  const [selector, ...rest] = action.positionals ?? [];
  if (rest.length > 0 || typeof selector !== 'string') return null;
  return selector;
}

function readPlainTypeText(action: SessionAction | undefined): string | null {
  if (action?.command !== 'type') return null;
  if (action.flags && Object.keys(action.flags).length > 0) return null;
  const [text, ...rest] = action.positionals ?? [];
  if (rest.length > 0 || typeof text !== 'string') return null;
  return text;
}

function isLikelyTextEntrySelector(selector: string): boolean {
  return /\b(input|textfield|textarea|field|email|password|username|search|query)\b/i.test(
    selector.replace(/([a-z])([A-Z])/g, '$1 $2'),
  );
}

function createParseContext(options: MaestroParseOptions): MaestroParseContext {
  const visitedPaths = options.visitedPaths ?? new Set<string>();
  if (options.sourcePath) visitedPaths.add(path.resolve(options.sourcePath));
  return {
    baseDir: options.sourcePath ? path.dirname(options.sourcePath) : undefined,
    platform: normalizePlatform(options.platform),
    env: {},
    envOverrides: options.env ?? {},
    visitedPaths,
  };
}

function findMaestroCommandLines(script: string): number[] {
  const lines = script.split(/\r?\n/);
  const separatorIndex = lines.findIndex((line) => line.trim() === '---');
  const firstCommandLine = separatorIndex === -1 ? 0 : separatorIndex + 1;
  const commandLines: number[] = [];
  for (let index = firstCommandLine; index < lines.length; index += 1) {
    if (/^-\s+/.test(lines[index] ?? '')) commandLines.push(index + 1);
  }
  return commandLines;
}

function splitMaestroDocuments(values: unknown[]): {
  config: MaestroFlowConfig;
  commands: MaestroCommand[];
} {
  if (values.length === 0) {
    throw new AppError('INVALID_ARGS', 'Maestro flow is empty.');
  }

  if (Array.isArray(values[0])) {
    return { config: {}, commands: normalizeCommandList(values[0]) };
  }

  const config = normalizeConfig(values[0]);
  const commandDocument = values[1];
  if (!Array.isArray(commandDocument)) {
    throw new AppError(
      'INVALID_ARGS',
      'Maestro flow must contain a command list after the YAML document separator.',
    );
  }
  return { config, commands: normalizeCommandList(commandDocument) };
}

function normalizeConfig(value: unknown): MaestroFlowConfig {
  if (!isPlainRecord(value)) {
    throw new AppError('INVALID_ARGS', 'Maestro flow config must be a YAML map.');
  }
  return {
    ...(typeof value.name === 'string' && value.name.length > 0 ? { name: value.name } : {}),
    ...(typeof value.appId === 'string' && value.appId.length > 0 ? { appId: value.appId } : {}),
    ...(isPlainRecord(value.env) ? { env: readEnvMap(value.env, 'env') } : {}),
    ...(Array.isArray(value.onFlowStart)
      ? { onFlowStart: normalizeCommandList(value.onFlowStart) }
      : {}),
    ...(Array.isArray(value.onFlowComplete)
      ? { onFlowComplete: normalizeCommandList(value.onFlowComplete) }
      : {}),
  };
}

/**
 * Parses a `runFlow`-included file, resolving `undefined` (this-file) source
 * paths to the include's own resolved path; deeper nested includes keep the
 * path a recursive call already stamped.
 */
function parseRunFlowFile(filePath: string, context: MaestroParseContext): MaestroReplayFlow {
  const resolved = resolveRunFlowPath(filePath, context);
  if (context.visitedPaths.has(resolved)) {
    throw new AppError('INVALID_ARGS', `Maestro runFlow cycle detected at ${resolved}.`);
  }
  const script = fs.readFileSync(resolved, 'utf8');
  const visitedPaths = new Set(context.visitedPaths);
  visitedPaths.add(resolved);
  const flow = parseMaestroReplayFlowInternal(script, {
    ...context,
    baseDir: path.dirname(resolved),
    visitedPaths,
  });
  return {
    ...flow,
    actionSourcePaths: (flow.actionSourcePaths ?? flow.actions.map(() => undefined)).map(
      (sourcePath) => sourcePath ?? resolved,
    ),
  };
}

function resolveRunFlowPath(filePath: string, context: MaestroParseContext): string {
  if (path.isAbsolute(filePath)) return filePath;
  if (!context.baseDir) {
    throw new AppError(
      'INVALID_ARGS',
      'runFlow file paths require replay input to have a source path.',
    );
  }
  return path.resolve(context.baseDir, filePath);
}
