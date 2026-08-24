// Canonical projection shared by both engines. Layer-1 conformance compares the
// upstream parser capture (generated) and our engine's live parse after both are
// projected into this representation. It captures the conformance-critical
// essence of each command — identity, selectors, geometry, gesture direction,
// retry/repeat counts, launch flags — and deliberately drops representation-only
// differences (regex-vs-literal selector storage, runScript path-vs-content,
// nested runFlow expansion) that the two IR designs express differently.

import type { MaestroCommand, MaestroProgram, MaestroSwipeGesture } from './program-ir.ts';
import { MAESTRO_COMPATIBILITY_PRESETS } from './compatibility-policy.ts';
import { asRecord, bool, dropUndefined, numLike, str } from './conformance-value-coercion.ts';
import {
  canonicalizeAgentSelector,
  canonicalizeAgentPoint,
  canonicalizeAgentTarget,
  canonicalizeUpstreamPoint,
  canonicalizeUpstreamSelector,
  type CanonicalPoint,
  type CanonicalSelector,
  type CanonicalTarget,
} from './conformance-selector-projection.ts';

export type {
  CanonicalPoint,
  CanonicalSelector,
  CanonicalTarget,
} from './conformance-selector-projection.ts';

export type CanonicalGesture =
  | { mode: 'direction'; direction: string; duration?: number | string }
  | {
      mode: 'coordinates';
      start?: CanonicalPoint;
      end?: CanonicalPoint;
      duration?: number | string;
    }
  | { mode: 'element'; from: CanonicalSelector; direction?: string; duration?: number | string };

export type CanonicalCommand =
  | { kind: 'launchApp'; appId?: string; clearState?: boolean; stopApp?: boolean }
  // Upstream models `doubleTapOn` as a tap with repeat.repeat == 2, so the repeat
  // COUNT is the canonical field on both sides rather than a `double` variant on
  // one — that keeps our distinct tapOn/doubleTapOn kinds comparable to upstream
  // and preserves conformance signal for tapOn.repeat/delay.
  | {
      kind: 'tap';
      longPress: boolean;
      repeat: number | string;
      delay?: number | string;
      label?: string;
      target: CanonicalTarget;
    }
  | {
      kind: 'assert';
      mode: 'visible' | 'notVisible' | 'true';
      timed: boolean;
      timeout?: number | string;
      label?: string;
      selector?: CanonicalSelector;
      expression?: string;
    }
  | { kind: 'swipe'; label?: string; gesture: CanonicalGesture }
  | { kind: 'inputText'; label?: string; text?: string }
  | { kind: 'eraseText'; count?: number | string }
  | { kind: 'openLink'; link?: string }
  | { kind: 'scroll' }
  | {
      kind: 'scrollUntilVisible';
      direction?: string;
      label?: string;
      selector?: CanonicalSelector;
      timeout?: number | string;
    }
  | { kind: 'pressKey'; key: string }
  | { kind: 'back' }
  | { kind: 'hideKeyboard' }
  | { kind: 'takeScreenshot' }
  | { kind: 'waitForAnimationToEnd'; timeout?: number | string }
  | { kind: 'stopApp' }
  | { kind: 'repeat'; times: string | number }
  | { kind: 'retry'; maxRetries?: string | number }
  | { kind: 'runFlow'; label?: string; source: 'file' | 'commands' }
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
        repeat: numLike(repeat?.repeat) ?? str(repeat?.repeat) ?? 1,
        delay: numLike(repeat?.delay) ?? str(repeat?.delay),
        label: str(f.label),
        target: { selector: canonicalizeUpstreamSelector(f.selector) },
      });
    }
    case 'TapOnPointV2Command':
    case 'TapOnPointCommand':
      return canonicalTap({
        longPress: false,
        repeat: 1,
        label: str(f.label),
        target: { point: canonicalizeUpstreamPoint(f.point) },
      });
    case 'AssertConditionCommand': {
      // Upstream serializes every condition slot; the active one is non-null.
      const condition = asRecord(f.condition) ?? {};
      const timeout = numLike(f.timeout) ?? str(f.timeout);
      if (condition.visible != null) {
        return dropUndefined({
          kind: 'assert',
          mode: 'visible',
          timed: f.timeout != null,
          timeout,
          label: str(f.label),
          selector: canonicalizeUpstreamSelector(condition.visible),
        });
      }
      if (condition.notVisible != null) {
        return dropUndefined({
          kind: 'assert',
          mode: 'notVisible',
          timed: f.timeout != null,
          timeout,
          label: str(f.label),
          selector: canonicalizeUpstreamSelector(condition.notVisible),
        });
      }
      if (condition.scriptCondition != null) {
        return dropUndefined({
          kind: 'assert',
          mode: 'true',
          timed: f.timeout != null,
          timeout,
          label: str(f.label),
          expression: str(condition.scriptCondition),
        });
      }
      return { kind: 'unsupported', command: 'assertTrue' };
    }
    case 'SwipeCommand':
      return dropUndefined({ kind: 'swipe', label: str(f.label), gesture: upstreamGesture(f) });
    case 'ScrollCommand':
      return { kind: 'scroll' };
    case 'ScrollUntilVisibleCommand':
      return dropUndefined({
        kind: 'scrollUntilVisible',
        direction: lower(str(f.direction)),
        label: str(f.label),
        selector: canonicalizeUpstreamSelector(f.selector),
        timeout: numLike(f.timeout) ?? str(f.timeout),
      });
    case 'InputTextCommand':
      return dropUndefined({ kind: 'inputText', label: str(f.label), text: str(f.text) });
    case 'EraseTextCommand':
      return dropUndefined({
        kind: 'eraseText',
        count: numLike(f.charactersToErase) ?? str(f.charactersToErase),
      });
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
      return dropUndefined({
        kind: 'waitForAnimationToEnd',
        timeout: numLike(f.timeout) ?? str(f.timeout),
      });
    case 'StopAppCommand':
      return { kind: 'stopApp' };
    case 'RepeatCommand':
      return { kind: 'repeat', times: numLike(f.times) ?? str(f.times) ?? '' };
    case 'RetryCommand':
      return dropUndefined({
        kind: 'retry',
        maxRetries: numLike(f.maxRetries) ?? str(f.maxRetries),
      });
    case 'RunFlowCommand':
      return dropUndefined({
        kind: 'runFlow',
        label: str(f.label),
        source: f.sourceDescription != null ? 'file' : 'commands',
      });
    case 'RunScriptCommand':
      return { kind: 'runScript' };
    default:
      return { kind: 'unsupported', command: unsupportedName(command.type) };
  }
}

/**
 * Build a canonical tap from the effective repeat semantics. `delay` only means
 * anything for a repeated tap, so it is dropped for a single tap to keep the two
 * engines' representations comparable. Unresolved variable tokens are preserved
 * as strings so the canonical model does not silently default them.
 */
function canonicalTap(tap: {
  longPress: boolean;
  repeat: number | string;
  delay?: number | string;
  label?: string;
  target: CanonicalTarget;
}): CanonicalCommand {
  return dropUndefined({
    kind: 'tap',
    longPress: tap.longPress,
    repeat: tap.repeat,
    delay: typeof tap.repeat === 'number' && tap.repeat <= 1 ? undefined : tap.delay,
    label: tap.label,
    target: tap.target,
  });
}

function upstreamGesture(f: Record<string, unknown>): CanonicalGesture {
  const duration = numLike(f.duration) ?? str(f.duration);
  if (f.elementSelector != null) {
    return dropUndefined({
      mode: 'element',
      from: canonicalizeUpstreamSelector(f.elementSelector) ?? {},
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

function lower(value: string | undefined): string | undefined {
  return value?.toLowerCase();
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
      const repeat = numLike(command.repeat) ?? 1;
      const repeatIsNumber = typeof repeat === 'number';
      return canonicalTap({
        longPress: false,
        repeat,
        delay: repeatIsNumber
          ? (numLike(command.delay) ?? AGENT_REPEAT_DELAY_MS)
          : numLike(command.delay),
        label: command.label,
        target: canonicalizeAgentTarget(command.target),
      });
    }
    case 'doubleTapOn':
      // Upstream compiles doubleTapOn to a repeat-2 tap with the same default delay.
      return canonicalTap({
        longPress: false,
        repeat: 2,
        delay: numLike(command.delay) ?? AGENT_REPEAT_DELAY_MS,
        label: command.label,
        target: canonicalizeAgentTarget(command.target),
      });
    case 'longPressOn':
      return canonicalTap({
        longPress: true,
        repeat: 1,
        label: command.label,
        target: canonicalizeAgentTarget(command.target),
      });
    case 'assertVisible':
      return dropUndefined({
        kind: 'assert',
        mode: 'visible',
        timed: false,
        label: command.label,
        selector: canonicalizeAgentSelector(command.target),
      });
    case 'assertNotVisible':
      return dropUndefined({
        kind: 'assert',
        mode: 'notVisible',
        timed: false,
        label: command.label,
        selector: canonicalizeAgentSelector(command.target),
      });
    case 'assertTrue':
      return dropUndefined({
        kind: 'assert',
        mode: 'true',
        timed: false,
        label: command.label,
        expression: String(command.condition),
      });
    case 'extendedWaitUntil':
      return dropUndefined({
        kind: 'assert',
        mode: command.notVisible ? 'notVisible' : 'visible',
        timed: command.timeout != null,
        timeout: numLike(command.timeout),
        label: command.label,
        selector: canonicalizeAgentSelector(command.notVisible ?? command.visible),
      });
    case 'swipe':
      return { kind: 'swipe', label: command.label, gesture: agentGesture(command.gesture) };
    case 'inputText':
      return dropUndefined({ kind: 'inputText', label: command.label, text: command.text });
    case 'eraseText':
      return dropUndefined({ kind: 'eraseText', count: numLike(command.charactersToErase) });
    case 'openLink':
      return dropUndefined({ kind: 'openLink', link: command.link });
    case 'scroll':
      return { kind: 'scroll' };
    case 'scrollUntilVisible':
      // Upstream materializes the DOWN default onto the command at parse time;
      // our engine defers it to execution (runtime-port-commands.ts). Materialize
      // it here too so the comparison is on effective values, matching the same
      // pattern used for swipe duration and repeat delay above.
      return dropUndefined({
        kind: 'scrollUntilVisible',
        direction: command.direction ?? 'down',
        label: command.label,
        selector: canonicalizeAgentSelector(command.element),
        timeout: numLike(command.timeout),
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
      return dropUndefined({ kind: 'waitForAnimationToEnd', timeout: numLike(command.timeout) });
    case 'stopApp':
      return { kind: 'stopApp' };
    case 'repeat':
      return { kind: 'repeat', times: numLike(command.times) ?? str(command.times) ?? '' };
    case 'retry':
      return dropUndefined({
        kind: 'retry',
        maxRetries: numLike(command.maxRetries) ?? str(command.maxRetries),
      });
    case 'runFlow':
      return dropUndefined({
        kind: 'runFlow',
        label: command.label,
        source: command.include.kind === 'file' ? 'file' : 'commands',
      });
    case 'runScript':
      return { kind: 'runScript' };
    default: {
      const exhaustive: never = command;
      throw new Error(`Unhandled agent command: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function agentGesture(gesture: MaestroSwipeGesture): CanonicalGesture {
  const duration = numLike(gesture.duration) ?? AGENT_SWIPE_DEFAULT_DURATION;
  switch (gesture.kind) {
    case 'screen':
      return { mode: 'direction', direction: gesture.direction, duration };
    case 'coordinates':
      return dropUndefined({
        mode: 'coordinates',
        start: canonicalizeAgentPoint(gesture.start),
        end: canonicalizeAgentPoint(gesture.end),
        duration,
      });
    case 'target':
      return dropUndefined({
        mode: 'element',
        from: canonicalizeAgentSelector(gesture.from) ?? {},
        direction: gesture.direction,
        duration,
      });
  }
}
