import fs from 'node:fs';
import path from 'node:path';
import { parseMaestroReplayFlow } from '../src/compat/maestro/replay-flow.ts';
import type { SessionAction } from '../src/daemon/types.ts';
import {
  normalizeAgentSelector,
  normalizeUpstreamSelector,
} from './maestro-conformance-selectors.ts';
import type {
  NormalizedAction,
  NormalizedCase,
  NormalizedFixture,
  NormalizedSource,
  RawCase,
  RawCommand,
  RawFixture,
  UpstreamSource,
} from './maestro-conformance-types.ts';

const DEFAULT_SWIPE_DURATION_MS = 400;

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
  const parsed = parseMaestroReplayFlow(fs.readFileSync(flowPath, 'utf8'), {
    sourcePath: flowPath,
    platform: 'ios',
  });

  return {
    id: fixture.id,
    flow: fixture.flow,
    expected: parsed.actions.map((action, index) => {
      const line = parsed.actionLines[index] ?? index + 1;
      const sourcePath = parsed.actionSourcePaths?.[index] ?? flowPath;
      const source = normalizeSource({ path: sourcePath, line }, fixtureDirectory);
      return normalizeAgentAction(action, source);
    }),
  };
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
  const durationMs = integerOrDefault(command.duration, DEFAULT_SWIPE_DURATION_MS);
  const startRelative = optionalString(command, 'startRelative');
  const endRelative = optionalString(command, 'endRelative');
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

  const direction = optionalString(command, 'direction');
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

function normalizeAgentAction(action: SessionAction, source: NormalizedSource): NormalizedAction {
  switch (action.command) {
    case 'open':
      if (action.positionals.length !== 1) {
        throw new Error(`Unsupported open action shape: ${JSON.stringify(action.positionals)}`);
      }
      return {
        kind: 'launchApp',
        appId: action.positionals[0]!,
        stopApp: action.flags.relaunch === true,
        source,
      };
    case '__maestroSwipeScreen':
      return normalizeAgentScreenSwipe(action, source);
    case 'swipe':
      return normalizeAgentAbsoluteSwipe(action, source);
    case '__maestroTapOn':
      return {
        kind: 'tapOn',
        selector: normalizeAgentSelector(action.positionals[0], action.positionals[1]),
        source,
      };
    case '__maestroAssertVisible':
      return {
        kind: 'assertVisible',
        selector: normalizeAgentSelector(action.positionals[0]),
        timeoutMs: integerOrDefault(action.positionals[1], 17000),
        source,
      };
    case '__maestroAssertNotVisible':
      return {
        kind: 'assertNotVisible',
        selector: normalizeAgentSelector(action.positionals[0]),
        timeoutMs: integerOrDefault(action.positionals[1], 17000),
        source,
      };
    default:
      throw new Error(`Unsupported agent-device action in conformance fixture: ${action.command}`);
  }
}

function normalizeAgentScreenSwipe(
  action: SessionAction,
  source: NormalizedSource,
): NormalizedAction {
  const [mode, first, second, third, fourth, duration] = action.positionals;
  const durationMs = integerOrDefault(duration, DEFAULT_SWIPE_DURATION_MS);
  if (mode === 'direction' && first) {
    return { kind: 'swipe', mode, direction: first, durationMs, source };
  }
  if (mode === 'percent' && first && second && third && fourth) {
    return {
      kind: 'swipe',
      mode: 'relative',
      start: [numberToken(first), numberToken(second)],
      end: [numberToken(third), numberToken(fourth)],
      durationMs,
      source,
    };
  }
  throw new Error(`Unsupported screen swipe action shape: ${JSON.stringify(action.positionals)}`);
}

function normalizeAgentAbsoluteSwipe(
  action: SessionAction,
  source: NormalizedSource,
): NormalizedAction {
  const [startX, startY, endX, endY, duration] = action.positionals;
  if (!startX || !startY || !endX || !endY) {
    throw new Error(
      `Unsupported absolute swipe action shape: ${JSON.stringify(action.positionals)}`,
    );
  }
  return {
    kind: 'swipe',
    mode: 'absolute',
    start: [numberToken(startX), numberToken(startY)],
    end: [numberToken(endX), numberToken(endY)],
    durationMs: integerOrDefault(duration, DEFAULT_SWIPE_DURATION_MS),
    source,
  };
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

function numberToken(value: string): number {
  return numberValue(value, 'swipe coordinate');
}

function numberValue(value: unknown, name: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid ${name}: ${String(value)}`);
  return number;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string.`);
  return value;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = optionalString(record, key);
  if (value === undefined || value.length === 0) throw new Error(`${key} is required.`);
  return value;
}

function requiredRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return requiredRecordValue(record[key], key);
}

function requiredRecordValue(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
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
