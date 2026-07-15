import fs from 'node:fs';
import path from 'node:path';
import { parseMaestroProgram } from '../src/compat/maestro/program-ir-parser.ts';
import { MAESTRO_COMPATIBILITY_PRESETS } from '../src/compat/maestro/compatibility-policy.ts';
import type {
  MaestroCommand,
  MaestroProgram,
  MaestroSelector,
} from '../src/compat/maestro/program-ir.ts';
import { normalizeUpstreamSelector } from './maestro-conformance-selectors.ts';
import type {
  NormalizedAction,
  NormalizedCase,
  NormalizedFixture,
  NormalizedSelector,
  NormalizedSource,
  RawCase,
  RawCommand,
  RawFixture,
  UpstreamSource,
} from './maestro-conformance-types.ts';
import { readOptionalString, readRequiredRecord } from './maestro-conformance-values.ts';
import { stripUndefined } from '../src/utils/parsing.ts';

const UPSTREAM_DEFAULT_SWIPE_DURATION_MS = 400;

export function normalizeUpstreamFixture(
  fixture: RawFixture,
  fixtureDirectory: string,
): NormalizedFixture {
  return {
    schemaVersion: 1,
    upstream: fixture.upstream,
    cases: fixture.cases.map((entry) => ({
      id: entry.id,
      flow: entry.flow,
      expected: entry.commands.flatMap((command) =>
        normalizeUpstreamCommand(command, fixtureDirectory, {
          path: entry.flow,
          line: 1,
        }),
      ),
    })),
  };
}

export function normalizeAgentCase(fixture: RawCase, fixtureDirectory: string): NormalizedCase {
  const flowPath = resolveFixturePath(fixtureDirectory, fixture.flow);
  const program = parseMaestroProgram(fs.readFileSync(flowPath, 'utf8'), { sourcePath: flowPath });
  return {
    id: fixture.id,
    flow: fixture.flow,
    expected: normalizeAgentProgram(program, fixtureDirectory),
  };
}

function normalizeAgentProgram(
  program: MaestroProgram,
  fixtureDirectory: string,
): NormalizedAction[] {
  return [
    ...(program.config.onFlowStart ?? []),
    ...program.commands,
    ...(program.config.onFlowComplete ?? []),
  ].flatMap((command) => normalizeAgentCommand(command, program, fixtureDirectory));
}

function normalizeAgentCommand(
  command: MaestroCommand,
  program: MaestroProgram,
  fixtureDirectory: string,
): NormalizedAction[] {
  const source = normalizeSource(command.source, fixtureDirectory);
  switch (command.kind) {
    case 'runFlow':
      return normalizeAgentRunFlow(command, program, fixtureDirectory);
    case 'launchApp': {
      const appId = command.appId ?? program.config.appId;
      if (!appId) throw new Error('launchApp conformance fixture requires appId.');
      return [{ kind: 'launchApp', appId, stopApp: command.stopApp !== false, source }];
    }
    case 'swipe':
      return [normalizeAgentSwipe(command.gesture, source)];
    case 'tapOn':
      return [normalizeAgentTap(command, source)];
    case 'assertVisible':
    case 'assertNotVisible':
      return [
        {
          kind: command.kind,
          selector: normalizeTypedSelector(command.target),
          timeoutMs: MAESTRO_COMPATIBILITY_PRESETS.command.targetLookupTimeoutMs,
          source,
        },
      ];
    default:
      throw new Error(`Unsupported typed command in conformance fixture: ${command.kind}`);
  }
}

function normalizeAgentRunFlow(
  command: Extract<MaestroCommand, { kind: 'runFlow' }>,
  program: MaestroProgram,
  fixtureDirectory: string,
): NormalizedAction[] {
  if (command.include.kind === 'commands') {
    return command.include.commands.flatMap((nested) =>
      normalizeAgentCommand(nested, program, fixtureDirectory),
    );
  }
  const parentPath = command.source.path ?? program.source.path;
  if (!parentPath) throw new Error('File runFlow requires source path provenance.');
  const includePath = path.resolve(path.dirname(parentPath), command.include.path);
  const included = parseMaestroProgram(fs.readFileSync(includePath, 'utf8'), {
    sourcePath: includePath,
  });
  return normalizeAgentProgram(included, fixtureDirectory);
}

function normalizeAgentTap(
  command: Extract<MaestroCommand, { kind: 'tapOn' }>,
  source: NormalizedSource,
): NormalizedAction {
  if (command.target.space !== 'target') {
    throw new Error('tapOn conformance fixtures require selector targets.');
  }
  return {
    kind: 'tapOn',
    selector: stripUndefined({
      ...normalizeTypedSelector(command.target.selector),
      index: command.index,
      childOf: command.childOf ? normalizeTypedSelector(command.childOf) : undefined,
    }),
    source,
  };
}

function normalizeAgentSwipe(
  gesture: Extract<MaestroCommand, { kind: 'swipe' }>['gesture'],
  source: NormalizedSource,
): NormalizedAction {
  const durationMs = gesture.duration ?? MAESTRO_COMPATIBILITY_PRESETS.command.swipeDurationMs;
  if (gesture.kind === 'screen') {
    return { kind: 'swipe', mode: 'direction', direction: gesture.direction, durationMs, source };
  }
  if (gesture.kind === 'target') {
    throw new Error('Target-relative swipe is not part of the conformance fixture set.');
  }
  return {
    kind: 'swipe',
    mode: gesture.start.space === 'percent' ? 'relative' : 'absolute',
    start: [gesture.start.x, gesture.start.y],
    end: [gesture.end.x, gesture.end.y],
    durationMs,
    source,
  };
}

function normalizeTypedSelector(selector: MaestroSelector): NormalizedSelector {
  const text = selector.text ?? selector.label;
  return stripUndefined({ id: selector.id, text, enabled: selector.enabled, selected: selector.selected });
}

function normalizeUpstreamCommand(
  command: RawCommand,
  fixtureDirectory: string,
  fallbackSource: UpstreamSource,
): NormalizedAction[] {
  const source = normalizeSource(command.source ?? fallbackSource, fixtureDirectory);

  switch (command.type) {
    case 'RunFlowCommand': {
      if (!command.commands) throw new Error('RunFlowCommand artifact is missing commands.');
      return command.commands.flatMap((nested) =>
        normalizeUpstreamCommand(nested, fixtureDirectory, source),
      );
    }
    case 'LaunchAppCommand':
      return [
        {
          kind: 'launchApp',
          appId: requiredString(command, 'appId'),
          stopApp: command.stopApp !== false,
          source,
        },
      ];
    case 'SwipeCommand':
      return [normalizeUpstreamSwipe(command, source)];
    case 'TapOnElementCommand':
      return [
        {
          kind: 'tapOn',
          selector: normalizeUpstreamSelector(requiredRecord(command, 'selector')),
          source,
        },
      ];
    case 'AssertConditionCommand':
      return [normalizeUpstreamAssertion(command, source)];
    default:
      throw new Error(`Unsupported upstream command artifact: ${command.type}`);
  }
}

function normalizeUpstreamSwipe(command: RawCommand, source: NormalizedSource): NormalizedAction {
  const durationMs = integerOrDefault(command.duration, UPSTREAM_DEFAULT_SWIPE_DURATION_MS);
  const startRelative = readOptionalString(command, 'startRelative');
  const endRelative = readOptionalString(command, 'endRelative');
  if (startRelative !== undefined || endRelative !== undefined) {
    if (startRelative === undefined || endRelative === undefined) {
      throw new Error('SwipeCommand artifact must include both relative endpoints.');
    }
    return {
      kind: 'swipe',
      mode: 'relative',
      start: parsePoint(startRelative, '%'),
      end: parsePoint(endRelative, '%'),
      durationMs,
      source,
    };
  }

  const direction = readOptionalString(command, 'direction');
  if (direction !== undefined) {
    return {
      kind: 'swipe',
      mode: 'direction',
      direction: direction.toLowerCase(),
      durationMs,
      source,
    };
  }

  const startPoint = optionalPoint(command, 'startPoint');
  const endPoint = optionalPoint(command, 'endPoint');
  if (startPoint && endPoint) {
    return {
      kind: 'swipe',
      mode: 'absolute',
      start: startPoint,
      end: endPoint,
      durationMs,
      source,
    };
  }
  throw new Error('SwipeCommand artifact has no supported gesture shape.');
}

function normalizeUpstreamAssertion(
  command: RawCommand,
  source: NormalizedSource,
): NormalizedAction {
  const condition = requiredRecord(command, 'condition');
  const visible = condition.visible;
  const notVisible = condition.notVisible;
  if (visible !== undefined && notVisible === undefined) {
    return {
      kind: 'assertVisible',
      selector: normalizeUpstreamSelector(requiredRecordValue(visible, 'condition.visible')),
      timeoutMs: integerOrDefault(command.timeout, 17000),
      source,
    };
  }
  if (notVisible !== undefined && visible === undefined) {
    return {
      kind: 'assertNotVisible',
      selector: normalizeUpstreamSelector(requiredRecordValue(notVisible, 'condition.notVisible')),
      timeoutMs: integerOrDefault(command.timeout, 17000),
      source,
    };
  }
  throw new Error('AssertConditionCommand artifact must contain one condition.');
}

function optionalPoint(record: Record<string, unknown>, key: string): [number, number] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.length === 2) {
    return [numberValue(value[0], `${key}[0]`), numberValue(value[1], `${key}[1]`)] as [
      number,
      number,
    ];
  }
  if (typeof value === 'string') return parsePoint(value, '');
  throw new Error(`Unsupported ${key} point artifact.`);
}

function parsePoint(value: string, suffix: string): [number, number] {
  const escapedSuffix = suffix === '%' ? '%' : '';
  const match = value.match(
    new RegExp(
      `^\\s*(\\d+(?:\\.\\d+)?)${escapedSuffix}\\s*,\\s*(\\d+(?:\\.\\d+)?)${escapedSuffix}\\s*$`,
    ),
  );
  if (!match) throw new Error(`Invalid ${suffix ? 'relative ' : ''}point: ${value}`);
  return [Number(match[1]), Number(match[2])];
}

function integerOrDefault(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 0)
    throw new Error(`Expected non-negative integer, got ${value}`);
  return number;
}

function numberValue(value: unknown, name: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid ${name}: ${String(value)}`);
  return number;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = readOptionalString(record, key);
  if (value === undefined || value.length === 0) throw new Error(`${key} is required.`);
  return value;
}

function requiredRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return requiredRecordValue(record[key], key);
}

function requiredRecordValue(value: unknown, name: string): Record<string, unknown> {
  return readRequiredRecord(value, name);
}

function resolveFixturePath(fixtureDirectory: string, relativePath: string): string {
  const resolved = path.resolve(fixtureDirectory, relativePath);
  const relative = path.relative(fixtureDirectory, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Fixture path escapes fixture directory: ${relativePath}`);
  }
  return resolved;
}

function normalizeSource(source: UpstreamSource, fixtureDirectory: string): NormalizedSource {
  const resolved = path.resolve(fixtureDirectory, source.path);
  const relative = path.relative(fixtureDirectory, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Source path escapes fixture directory: ${source.path}`);
  }
  return { path: relative.split(path.sep).join('/'), line: source.line };
}
