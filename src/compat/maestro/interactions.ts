import type { SessionAction } from '../../daemon/types.ts';
import { AppError } from '../../kernel/errors.ts';
import {
  action,
  assertOnlyKeys,
  isPlainRecord,
  readTimeoutMs,
  requireStringValue,
  resolveMaestroString,
  unsupportedMaestroSyntax,
} from './support.ts';
import { parseAbsolutePoint, parseMaestroPoint } from './points.ts';
import { MAESTRO_RUNTIME_COMMAND } from './runtime-commands.ts';
import type { MaestroParseContext } from './types.ts';
import type { ScrollDirection } from '../../core/scroll-gesture.ts';

export function convertTapOn(value: unknown, context: MaestroParseContext): SessionAction {
  if (typeof value === 'string') {
    return action(
      MAESTRO_RUNTIME_COMMAND.tapOn,
      [visibleTextSelector(resolveMaestroString(value, context))],
      maestroTapOnFlags(value),
    );
  }
  if (isPlainRecord(value) && typeof value.point === 'string') {
    assertOnlyKeys(value, 'tapOn', ['point', 'repeat', 'delay', 'optional', 'label']);
    const point = parseMaestroPoint(value.point);
    if (point.kind === 'percent') {
      return action(
        MAESTRO_RUNTIME_COMMAND.tapPointPercent,
        [String(point.x), String(point.y)],
        tapFlags(value),
      );
    }
    return action('click', [String(point.x), String(point.y)], tapFlags(value));
  }
  if (isPlainRecord(value)) {
    assertOnlyKeys(value, 'tapOn', [
      'id',
      'text',
      'childOf',
      'enabled',
      'index',
      'selected',
      'repeat',
      'delay',
      'optional',
      'label',
    ]);
  }
  const flags = maestroTapOnFlags(value);
  return action(
    MAESTRO_RUNTIME_COMMAND.tapOn,
    [
      maestroSelector(
        value,
        'tapOn',
        ['repeat', 'delay', 'optional', 'label', 'index', 'childOf'],
        context,
      ),
      ...maestroTapOnRuntimeOptions(value, context),
    ],
    flags,
  );
}

export function convertDoubleTapOn(value: unknown, context: MaestroParseContext): SessionAction {
  if (isPlainRecord(value) && typeof value.point === 'string') {
    assertOnlyKeys(value, 'doubleTapOn', ['point', 'delay']);
    const point = parseAbsolutePoint(value.point);
    return action('click', [String(point.x), String(point.y)], doubleTapFlags(value));
  }
  if (isPlainRecord(value)) {
    assertOnlyKeys(value, 'doubleTapOn', ['id', 'text', 'enabled', 'selected', 'delay']);
  }
  return action(
    'click',
    [maestroSelector(value, 'doubleTapOn', ['delay'], context)],
    doubleTapFlags(value),
  );
}

export function convertLongPressOn(value: unknown, context: MaestroParseContext): SessionAction {
  if (isPlainRecord(value) && typeof value.point === 'string') {
    assertOnlyKeys(value, 'longPressOn', ['point']);
    const point = parseAbsolutePoint(value.point);
    return action('longpress', [String(point.x), String(point.y), '3000']);
  }
  if (isPlainRecord(value)) {
    assertOnlyKeys(value, 'longPressOn', ['id', 'text', 'enabled', 'selected']);
  }
  return action('click', [maestroSelector(value, 'longPressOn', [], context)], { holdMs: 3000 });
}

export function readInputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isPlainRecord(value)) {
    throw new AppError('INVALID_ARGS', 'inputText expects a string or map.');
  }
  assertOnlyKeys(value, 'inputText', ['text', 'label']);
  if (typeof value.text !== 'string') {
    throw new AppError('INVALID_ARGS', 'inputText map requires a string text field.');
  }
  return value.text;
}

export function convertEraseText(value: unknown): SessionAction {
  if (value === null || value === undefined) return action('type', ['\b'.repeat(50)]);
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return action('type', ['\b'.repeat(value)]);
  }
  if (!isPlainRecord(value)) {
    throw new AppError('INVALID_ARGS', 'eraseText expects empty, a positive count, or a map.');
  }
  assertOnlyKeys(value, 'eraseText', ['charactersToErase']);
  if (value.charactersToErase === undefined) return action('type', ['\b'.repeat(50)]);
  if (
    typeof value.charactersToErase !== 'number' ||
    !Number.isInteger(value.charactersToErase) ||
    value.charactersToErase <= 0
  ) {
    throw new AppError('INVALID_ARGS', 'eraseText.charactersToErase must be a positive integer.');
  }
  return action('type', ['\b'.repeat(value.charactersToErase)]);
}

export function convertExtendedWaitUntil(
  value: unknown,
  context: MaestroParseContext,
): SessionAction[] {
  if (!isPlainRecord(value)) {
    throw new AppError('INVALID_ARGS', 'extendedWaitUntil expects a map.');
  }
  assertOnlyKeys(value, 'extendedWaitUntil', ['visible', 'notVisible', 'timeout']);
  const target = value.visible ?? value.notVisible;
  if (target === undefined) {
    throw unsupportedMaestroSyntax(
      'Only Maestro extendedWaitUntil.visible/notVisible is supported.',
    );
  }
  const selector = maestroSelector(target, 'extendedWaitUntil', [], context);
  const timeoutMs = String(readTimeoutMs(value, 17000));
  if (value.notVisible !== undefined) {
    return [action(MAESTRO_RUNTIME_COMMAND.assertNotVisible, [selector, timeoutMs])];
  }
  return [
    action(MAESTRO_RUNTIME_COMMAND.assertVisible, [selector, timeoutMs], {
      maestro: { allowAlreadyPastLoading: true },
    }),
  ];
}

export function convertScroll(value: unknown): SessionAction {
  if (value !== null && value !== undefined) {
    throw unsupportedMaestroSyntax('Maestro scroll options are not supported yet.');
  }
  return action('scroll', ['down']);
}

export function convertScrollUntilVisible(
  value: unknown,
  context: MaestroParseContext,
): SessionAction[] {
  if (typeof value === 'string') {
    return [
      action(MAESTRO_RUNTIME_COMMAND.scrollUntilVisible, [
        visibleTextSelector(resolveMaestroString(value, context)),
        '5000',
        'down',
      ]),
    ];
  }
  if (!isPlainRecord(value)) {
    throw new AppError('INVALID_ARGS', 'scrollUntilVisible expects a string or map.');
  }
  assertOnlyKeys(value, 'scrollUntilVisible', ['element', 'direction', 'timeout']);
  const selector = maestroSelector(value.element, 'scrollUntilVisible.element', [], context);
  const direction =
    typeof value.direction === 'string'
      ? readMaestroDirection(value.direction, 'scrollUntilVisible.direction')
      : 'down';
  const timeoutMs = String(readTimeoutMs(value, 5000));
  return [action(MAESTRO_RUNTIME_COMMAND.scrollUntilVisible, [selector, timeoutMs, direction])];
}

export function convertSwipe(value: unknown, context: MaestroParseContext): SessionAction {
  if (!isPlainRecord(value)) {
    throw new AppError('INVALID_ARGS', 'swipe expects a map.');
  }
  assertOnlyKeys(value, 'swipe', ['start', 'end', 'direction', 'duration', 'from', 'label']);
  const from = value.from ?? (typeof value.label === 'string' ? value.label : undefined);
  if (from !== undefined) {
    return convertTargetedSwipe(value, from, context);
  }
  if (typeof value.direction === 'string') {
    return action(MAESTRO_RUNTIME_COMMAND.swipeScreen, [
      'direction',
      readSwipeDirection(value.direction),
      ...swipeDurationPositionals(value),
    ]);
  }
  return convertCoordinateSwipe(value);
}

function convertTargetedSwipe(
  value: Record<string, unknown>,
  from: unknown,
  context: MaestroParseContext,
): SessionAction {
  const direction = readSwipeDirection(
    typeof value.direction === 'string' ? value.direction : 'up',
  );
  return action(MAESTRO_RUNTIME_COMMAND.swipeOn, [
    maestroSelector(from, 'swipe.from', [], context),
    direction,
    ...swipeDurationPositionals(value),
  ]);
}

function convertCoordinateSwipe(value: Record<string, unknown>): SessionAction {
  const { start, end } = readCoordinateSwipePoints(value);
  const durationMs = readSwipeDurationMs(value.duration);
  return convertCoordinateSwipePoints(start, end, durationMs);
}

function readCoordinateSwipePoints(value: Record<string, unknown>): {
  start: ReturnType<typeof parseMaestroPoint>;
  end: ReturnType<typeof parseMaestroPoint>;
} {
  if (typeof value.start === 'string' && typeof value.end === 'string') {
    return { start: parseMaestroPoint(value.start), end: parseMaestroPoint(value.end) };
  }
  throw unsupportedMaestroSyntax('Only Maestro swipe start/end coordinates are supported.');
}

function readSwipeDurationMs(duration: unknown): string | undefined {
  return typeof duration === 'number' && Number.isFinite(duration)
    ? String(Math.max(16, Math.floor(duration)))
    : undefined;
}

function convertCoordinateSwipePoints(
  start: ReturnType<typeof parseMaestroPoint>,
  end: ReturnType<typeof parseMaestroPoint>,
  durationMs: string | undefined,
): SessionAction {
  if (start.kind === 'absolute' && end.kind === 'absolute') {
    return action('swipe', [
      String(start.x),
      String(start.y),
      String(end.x),
      String(end.y),
      ...(durationMs ? [durationMs] : []),
    ]);
  }
  if (start.kind === 'percent' && end.kind === 'percent') {
    return action(MAESTRO_RUNTIME_COMMAND.swipeScreen, [
      'percent',
      String(start.x),
      String(start.y),
      String(end.x),
      String(end.y),
      ...(durationMs ? [durationMs] : []),
    ]);
  }
  throw unsupportedMaestroSyntax(
    'Maestro swipe start/end must both be absolute pixels or both be percentages.',
  );
}

function readMaestroDirection(direction: string, name: string): ScrollDirection {
  const normalized = direction.toLowerCase();
  switch (normalized) {
    case 'up':
    case 'down':
    case 'left':
    case 'right':
      return normalized;
    default:
      throw unsupportedMaestroSyntax(`Maestro ${name} must be UP, DOWN, LEFT, or RIGHT.`);
  }
}

function readSwipeDirection(direction: string): ScrollDirection {
  return readMaestroDirection(direction, 'swipe direction');
}

export function convertPressKey(value: unknown): SessionAction {
  const key = requireStringValue('pressKey', value).toLowerCase();
  if (key === 'back') return action('back');
  if (key === 'enter' || key === 'return') return action(MAESTRO_RUNTIME_COMMAND.pressEnter);
  if (key === 'home') return action('home');
  throw unsupportedMaestroSyntax(`Maestro pressKey "${key}" is not supported yet.`);
}

export function maestroSelector(
  value: unknown,
  command: string,
  allowedExtraKeys: readonly string[] = [],
  context: MaestroParseContext,
): string {
  if (typeof value === 'string') return visibleTextSelector(resolveMaestroString(value, context));
  if (!isPlainRecord(value)) {
    throw new AppError('INVALID_ARGS', `${command} expects a string or selector map.`);
  }
  assertOnlyKeys(value, command, ['id', 'text', 'enabled', 'selected', ...allowedExtraKeys]);

  const terms: string[] = [];
  const stateTerms: string[] = [];
  if (typeof value.enabled === 'boolean')
    stateTerms.push(selectorTerm('enabled', String(value.enabled)));
  if (typeof value.selected === 'boolean')
    stateTerms.push(selectorTerm('selected', String(value.selected)));
  if (typeof value.id === 'string')
    terms.push(selectorTerm('id', resolveMaestroString(value.id, context)), ...stateTerms);
  if (typeof value.text === 'string' && terms.length === 0) {
    return visibleTextSelector(resolveMaestroString(value.text, context), stateTerms);
  }
  if (typeof value.label === 'string' && terms.length === 0)
    terms.push(selectorTerm('label', resolveMaestroString(value.label, context)), ...stateTerms);
  if (terms.length === 0 && stateTerms.length > 0) terms.push(...stateTerms);
  if (terms.length === 0) {
    throw new AppError(
      'INVALID_ARGS',
      `${command} selector map must include one of id, text, label, enabled, or selected.`,
    );
  }
  return terms.join(' ');
}

function visibleTextSelector(value: string, extraTerms: readonly string[] = []): string {
  return [
    [selectorTerm('label', value), ...extraTerms].join(' '),
    [selectorTerm('text', value), ...extraTerms].join(' '),
    [selectorTerm('id', value), ...extraTerms].join(' '),
  ].join(' || ');
}

function maestroTapOnRuntimeOptions(value: unknown, context: MaestroParseContext): string[] {
  if (!isPlainRecord(value)) return [];
  const options: { index?: number; childOf?: string } = {};
  if (value.index !== undefined) {
    if (typeof value.index !== 'number' || !Number.isInteger(value.index) || value.index < 0) {
      throw new AppError('INVALID_ARGS', 'tapOn.index must be a non-negative integer.');
    }
    options.index = value.index;
  }
  if (value.childOf !== undefined) {
    options.childOf = maestroSelector(value.childOf, 'tapOn.childOf', [], context);
  }
  return Object.keys(options).length > 0 ? [JSON.stringify(options)] : [];
}

function swipeDurationPositionals(value: Record<string, unknown>): string[] {
  const durationMs = readSwipeDurationMs(value.duration);
  return durationMs ? [durationMs] : [];
}

function selectorTerm(key: string, value: string): string {
  return `${key}=${JSON.stringify(value)}`;
}

function tapFlags(value: unknown): SessionAction['flags'] | undefined {
  if (!isPlainRecord(value)) return undefined;
  const flags: SessionAction['flags'] = {};
  const repeat = positiveInteger(value.repeat);
  const delay = nonNegativeInteger(value.delay);
  if (repeat && repeat > 1) flags.count = repeat;
  if (delay !== undefined) flags.intervalMs = delay;
  if (value.optional === true) flags.maestro = { optional: true };
  return Object.keys(flags).length > 0 ? flags : undefined;
}

function maestroTapOnFlags(value: unknown): SessionAction['flags'] {
  const flags = tapFlags(value) ?? {};
  return {
    ...flags,
    maestro: {
      ...(flags.maestro ?? {}),
      allowNonHittableCoordinateFallback: true,
    },
  };
}

function doubleTapFlags(value: unknown): SessionAction['flags'] {
  const flags: SessionAction['flags'] = { doubleTap: true };
  if (isPlainRecord(value) && typeof value.delay === 'number' && Number.isInteger(value.delay)) {
    flags.intervalMs = Math.max(0, value.delay);
  }
  return flags;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}
