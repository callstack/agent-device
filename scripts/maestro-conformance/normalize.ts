// Canonical projection shared by both engines. Layer-1 conformance compares the
// upstream parser capture (generated) and our engine's live parse after both are
// projected into this representation. It captures the conformance-critical
// essence of each command — identity, selectors, geometry, gesture direction,
// retry/repeat counts, launch flags — and deliberately drops representation-only
// differences (regex-vs-literal selector storage, runScript path-vs-content,
// nested runFlow expansion) that the two IR designs express differently.

import type {
  MaestroCommand,
  MaestroGestureTarget,
  MaestroProgram,
  MaestroSelector,
  MaestroSwipeGesture,
} from '../../src/compat/maestro/program-ir.ts';
import { MAESTRO_COMPATIBILITY_PRESETS } from '../../src/compat/maestro/compatibility-policy.ts';

export type CanonicalSelector = {
  text?: string;
  id?: string;
  index?: number;
  enabled?: boolean;
  selected?: boolean;
  childOf?: CanonicalSelector;
};

export type CanonicalPoint = { x: number; y: number; unit: 'px' | 'percent'; expr?: string };

export type CanonicalTarget = {
  selector?: CanonicalSelector;
  point?: CanonicalPoint;
};

export type CanonicalGesture =
  | { mode: 'direction'; direction: string; duration?: number }
  | { mode: 'coordinates'; start?: CanonicalPoint; end?: CanonicalPoint; duration?: number }
  | { mode: 'element'; from: CanonicalSelector; direction?: string; duration?: number };

export type CanonicalCommand =
  | { kind: 'launchApp'; appId?: string; clearState?: boolean; stopApp?: boolean }
  // Upstream models `doubleTapOn` as a tap with repeat.repeat == 2, so the repeat
  // COUNT is the canonical field on both sides rather than a `double` variant on
  // one — that keeps our distinct tapOn/doubleTapOn kinds comparable to upstream
  // and preserves conformance signal for tapOn.repeat/delay.
  | { kind: 'tap'; longPress: boolean; repeat: number; delay?: number; target: CanonicalTarget }
  | { kind: 'assert'; mode: 'visible' | 'notVisible'; timed: boolean; selector?: CanonicalSelector }
  | { kind: 'swipe'; gesture: CanonicalGesture }
  | { kind: 'inputText'; text?: string }
  | { kind: 'eraseText'; count?: number }
  | { kind: 'openLink'; link?: string }
  | { kind: 'scroll' }
  | { kind: 'scrollUntilVisible'; direction?: string; selector?: CanonicalSelector }
  | { kind: 'pressKey'; key: string }
  | { kind: 'back' }
  | { kind: 'hideKeyboard' }
  | { kind: 'takeScreenshot' }
  | { kind: 'waitForAnimationToEnd'; timeout?: number }
  | { kind: 'stopApp' }
  | { kind: 'repeat'; times: string | number }
  | { kind: 'retry'; maxRetries?: string | number }
  | { kind: 'runFlow'; source: 'file' | 'commands' }
  | { kind: 'runScript' }
  | { kind: 'unsupported'; command: string };

// ---------------------------------------------------------------------------
// Upstream (generated capture) → canonical
// ---------------------------------------------------------------------------

/** Upstream command-model types that carry flow config, not a runnable step. */
const UPSTREAM_CONFIG_TYPES = new Set(['ApplyConfigurationCommand', 'DefineVariablesCommand']);

type UpstreamCommand = { type: string; fields: Record<string, unknown> };

export function canonicalizeUpstreamFlow(commands: UpstreamCommand[]): CanonicalCommand[] {
  return commands
    .filter((command) => !UPSTREAM_CONFIG_TYPES.has(command.type))
    .map(canonicalizeUpstreamCommand);
}

function canonicalizeUpstreamCommand(command: UpstreamCommand): CanonicalCommand {
  const f = command.fields;
  switch (command.type) {
    case 'LaunchAppCommand':
      return dropUndefined({
        kind: 'launchApp',
        appId: str(f.appId),
        clearState: bool(f.clearState),
        stopApp: bool(f.stopApp),
      });
    case 'TapOnElementCommand': {
      const repeat = asRecord(f.repeat);
      return canonicalTap({
        longPress: bool(f.longPress) ?? false,
        repeat: num(repeat?.repeat) ?? 1,
        delay: num(repeat?.delay),
        target: { selector: upstreamSelector(f.selector) },
      });
    }
    case 'TapOnPointV2Command':
    case 'TapOnPointCommand':
      return canonicalTap({
        longPress: false,
        repeat: 1,
        target: { point: upstreamPoint(f.point) },
      });
    case 'AssertConditionCommand': {
      // Upstream serializes every condition slot; the active one is non-null.
      const condition = asRecord(f.condition) ?? {};
      if (condition.visible != null) {
        return dropUndefined({
          kind: 'assert',
          mode: 'visible',
          timed: f.timeout != null,
          selector: upstreamSelector(condition.visible),
        });
      }
      if (condition.notVisible != null) {
        return dropUndefined({
          kind: 'assert',
          mode: 'notVisible',
          timed: f.timeout != null,
          selector: upstreamSelector(condition.notVisible),
        });
      }
      return { kind: 'unsupported', command: 'assertTrue' };
    }
    case 'SwipeCommand':
      return { kind: 'swipe', gesture: upstreamGesture(f) };
    case 'ScrollCommand':
      return { kind: 'scroll' };
    case 'ScrollUntilVisibleCommand':
      return dropUndefined({
        kind: 'scrollUntilVisible',
        direction: lower(str(f.direction)),
        selector: upstreamSelector(f.selector),
      });
    case 'InputTextCommand':
      return dropUndefined({ kind: 'inputText', text: str(f.text) });
    case 'EraseTextCommand':
      return dropUndefined({ kind: 'eraseText', count: num(f.charactersToErase) });
    case 'OpenLinkCommand':
      return dropUndefined({ kind: 'openLink', link: str(f.link) });
    case 'PressKeyCommand':
      return { kind: 'pressKey', key: lower(str(f.code)) ?? '' };
    case 'BackPressCommand':
      return { kind: 'back' };
    case 'HideKeyboardCommand':
      return { kind: 'hideKeyboard' };
    case 'TakeScreenshotCommand':
      return { kind: 'takeScreenshot' };
    case 'WaitForAnimationToEndCommand':
      return dropUndefined({ kind: 'waitForAnimationToEnd', timeout: numLike(f.timeout) });
    case 'StopAppCommand':
      return { kind: 'stopApp' };
    case 'RepeatCommand':
      return { kind: 'repeat', times: numLike(f.times) ?? str(f.times) ?? '' };
    case 'RetryCommand':
      return dropUndefined({ kind: 'retry', maxRetries: numLike(f.maxRetries) ?? str(f.maxRetries) });
    case 'RunFlowCommand':
      return { kind: 'runFlow', source: f.sourceDescription != null ? 'file' : 'commands' };
    case 'RunScriptCommand':
      return { kind: 'runScript' };
    default:
      return { kind: 'unsupported', command: unsupportedName(command.type) };
  }
}

/**
 * Build a canonical tap from the effective repeat semantics. `delay` only means
 * anything for a repeated tap, so it is dropped for a single tap to keep the two
 * engines' representations comparable.
 */
function canonicalTap(tap: {
  longPress: boolean;
  repeat: number;
  delay?: number;
  target: CanonicalTarget;
}): CanonicalCommand {
  return dropUndefined({
    kind: 'tap',
    longPress: tap.longPress,
    repeat: tap.repeat,
    delay: tap.repeat > 1 ? tap.delay : undefined,
    target: tap.target,
  });
}

function upstreamSelector(value: unknown): CanonicalSelector | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return dropUndefined({
    text: str(record.textRegex),
    id: str(record.idRegex),
    index: numLike(record.index),
    enabled: bool(record.enabled),
    selected: bool(record.selected),
    childOf: upstreamSelector(record.childOf),
  });
}

/**
 * A point the upstream parser accepted but we cannot canonicalize is a hole in
 * the oracle, not a value to drop: silently returning undefined would erase the
 * point from BOTH sides of the comparison and make an unequal pair compare equal.
 * Fail loudly so the projection gets fixed instead.
 */
function upstreamPoint(value: unknown): CanonicalPoint | undefined {
  const text = str(value);
  if (!text) return undefined;
  const match = /^\s*(-?\d+)(%?)\s*,\s*(-?\d+)(%?)\s*$/.exec(text);
  if (!match) {
    throw new Error(
      `Cannot canonicalize upstream point ${JSON.stringify(text)}; extend upstreamPoint() in normalize.ts.`,
    );
  }
  const unit = match[2] === '%' || match[4] === '%' ? 'percent' : 'px';
  return { x: Number(match[1]), y: Number(match[3]), unit };
}

function upstreamGesture(f: Record<string, unknown>): CanonicalGesture {
  const duration = num(f.duration);
  if (f.elementSelector != null) {
    return dropUndefined({
      mode: 'element',
      from: upstreamSelector(f.elementSelector) ?? {},
      direction: lower(str(f.direction)),
      duration,
    });
  }
  if (f.direction != null && f.startRelative == null && f.startPoint == null) {
    return dropUndefined({ mode: 'direction', direction: lower(str(f.direction)) ?? '', duration });
  }
  return dropUndefined({
    mode: 'coordinates',
    start: pointFromRelativeOrPoint(f.startRelative, f.startPoint),
    end: pointFromRelativeOrPoint(f.endRelative, f.endPoint),
    duration,
  });
}

function pointFromRelativeOrPoint(relative: unknown, point: unknown): CanonicalPoint | undefined {
  const rel = str(relative);
  if (rel) {
    const match = /^\s*(\d+)%\s*,\s*(\d+)%\s*$/.exec(rel);
    if (match) return { x: Number(match[1]), y: Number(match[2]), unit: 'percent' };
  }
  // Absolute swipe endpoints are captured as Point objects, not "x,y" strings.
  const record = asRecord(point);
  if (record && typeof record.x === 'number' && typeof record.y === 'number') {
    return { x: record.x, y: record.y, unit: 'px' };
  }
  return undefined;
}

function unsupportedName(type: string): string {
  // e.g. CopyTextFromCommand -> copyTextFrom
  const base = type.replace(/Command$/, '');
  return base.charAt(0).toLowerCase() + base.slice(1);
}

// ---------------------------------------------------------------------------
// Small coercion helpers (upstream stores several fields as strings)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
function lower(value: string | undefined): string | undefined {
  return value?.toLowerCase();
}
/** Coerce a numeric-or-string field to a number when it is a plain integer. */
function numLike(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

export function dropUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

// ---------------------------------------------------------------------------
// agent-device engine IR → canonical
// ---------------------------------------------------------------------------

// Upstream materializes these defaults onto the command at parse time (config
// appId onto a bare launchApp, the 400ms swipe duration); our engine defers them
// to execution. Materialize them here so the comparison is on effective values.
const AGENT_SWIPE_DEFAULT_DURATION = MAESTRO_COMPATIBILITY_PRESETS.command.swipeDurationMs;
const AGENT_REPEAT_DELAY_MS = MAESTRO_COMPATIBILITY_PRESETS.command.repeatDelayMs;

export function canonicalizeAgentCommands(
  program: Pick<MaestroProgram, 'commands' | 'config'>,
): CanonicalCommand[] {
  return program.commands.map((command) => canonicalizeAgentCommand(command, program.config));
}

function canonicalizeAgentCommand(
  command: MaestroCommand,
  config: MaestroProgram['config'],
): CanonicalCommand {
  switch (command.kind) {
    case 'launchApp':
      return dropUndefined({
        kind: 'launchApp',
        appId: command.appId ?? config.appId,
        clearState: command.clearState,
        stopApp: command.stopApp,
      });
    case 'tapOn': {
      const repeat = command.repeat ?? 1;
      return canonicalTap({
        longPress: false,
        repeat,
        delay: repeat > 1 ? (command.delay ?? AGENT_REPEAT_DELAY_MS) : undefined,
        target: agentTarget(command.target, command.index, command.childOf),
      });
    }
    case 'doubleTapOn':
      // Upstream compiles doubleTapOn to a repeat-2 tap with the same default delay.
      return canonicalTap({
        longPress: false,
        repeat: 2,
        delay: command.delay ?? AGENT_REPEAT_DELAY_MS,
        target: agentTarget(command.target),
      });
    case 'longPressOn':
      return canonicalTap({ longPress: true, repeat: 1, target: agentTarget(command.target) });
    case 'assertVisible':
      return dropUndefined({
        kind: 'assert',
        mode: 'visible',
        timed: false,
        selector: agentSelector(command.target, command.childOf),
      });
    case 'assertNotVisible':
      return dropUndefined({
        kind: 'assert',
        mode: 'notVisible',
        timed: false,
        selector: agentSelector(command.target, command.childOf),
      });
    case 'extendedWaitUntil':
      return dropUndefined({
        kind: 'assert',
        mode: command.notVisible ? 'notVisible' : 'visible',
        timed: true,
        selector: agentSelector(command.notVisible ?? command.visible),
      });
    case 'swipe':
      return { kind: 'swipe', gesture: agentGesture(command.gesture) };
    case 'inputText':
      return dropUndefined({ kind: 'inputText', text: command.text });
    case 'eraseText':
      return dropUndefined({ kind: 'eraseText', count: command.charactersToErase });
    case 'openLink':
      return dropUndefined({ kind: 'openLink', link: command.link });
    case 'scroll':
      return { kind: 'scroll' };
    case 'scrollUntilVisible':
      return dropUndefined({
        kind: 'scrollUntilVisible',
        direction: command.direction,
        selector: agentSelector(command.element),
      });
    case 'pressKey':
      return { kind: 'pressKey', key: command.key.toLowerCase() };
    case 'back':
      return { kind: 'back' };
    case 'hideKeyboard':
      return { kind: 'hideKeyboard' };
    case 'takeScreenshot':
      return { kind: 'takeScreenshot' };
    case 'waitForAnimationToEnd':
      return dropUndefined({ kind: 'waitForAnimationToEnd', timeout: command.timeout });
    case 'stopApp':
      return { kind: 'stopApp' };
    case 'repeat':
      return { kind: 'repeat', times: command.times };
    case 'retry':
      return dropUndefined({ kind: 'retry', maxRetries: command.maxRetries });
    case 'runFlow':
      return { kind: 'runFlow', source: command.include.kind === 'file' ? 'file' : 'commands' };
    case 'runScript':
      return { kind: 'runScript' };
    default: {
      const exhaustive: never = command;
      throw new Error(`Unhandled agent command: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function agentTarget(
  target: MaestroGestureTarget,
  index?: number,
  childOf?: MaestroSelector,
): CanonicalTarget {
  if (target.space === 'target') {
    return {
      selector: dropUndefined({
        ...agentSelector(target.selector),
        index,
        childOf: childOf ? agentSelector(childOf) : undefined,
      }),
    };
  }
  return { point: { x: target.x, y: target.y, unit: target.space === 'percent' ? 'percent' : 'px' } };
}

function agentSelector(
  selector: MaestroSelector | undefined,
  childOf?: MaestroSelector,
): CanonicalSelector | undefined {
  if (!selector) return undefined;
  return dropUndefined({
    text: selector.text,
    id: selector.id,
    enabled: selector.enabled,
    selected: selector.selected,
    childOf: childOf ? agentSelector(childOf) : undefined,
  });
}

function agentGesture(gesture: MaestroSwipeGesture): CanonicalGesture {
  const duration = gesture.duration ?? AGENT_SWIPE_DEFAULT_DURATION;
  switch (gesture.kind) {
    case 'screen':
      return { mode: 'direction', direction: gesture.direction, duration };
    case 'coordinates':
      return dropUndefined({
        mode: 'coordinates',
        start: agentPoint(gesture.start),
        end: agentPoint(gesture.end),
        duration,
      });
    case 'target':
      return dropUndefined({
        mode: 'element',
        from: agentSelector(gesture.from) ?? {},
        direction: gesture.direction,
        duration,
      });
  }
}

function agentPoint(coordinate: { space: 'absolute' | 'percent'; x: number; y: number }): CanonicalPoint {
  return { x: coordinate.x, y: coordinate.y, unit: coordinate.space === 'percent' ? 'percent' : 'px' };
}
