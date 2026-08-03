import { resolveCommandRecordingEffect } from '../core/command-descriptor/registry.ts';
import { parseWaitPositionals } from '../core/wait-positionals.ts';
import { AppError } from '@agent-device/kernel/errors';
import { isTouchTargetCommand } from '@agent-device/ad-script';
import { dragGesturePayloadFromPositionals } from '@agent-device/contracts/interaction';
import { isValidSelectorExpression } from '@agent-device/selectors';
import type { SessionAction } from './types.ts';

export function validateActivePublicationActions(actions: SessionAction[]): void {
  const openIndexes = actions.flatMap((action, index) =>
    action.command === 'open' ? [index] : [],
  );
  if (openIndexes.length !== 1 || openIndexes[0] !== 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'Cannot publish this session: an open-to-destination script requires exactly one initial recorded open.',
      {
        retriable: false,
        hint: 'Close this session and start a fresh one with open <app> --save-script[=<path>].',
      },
    );
  }
  if (actions.some((action) => action.command === 'close')) {
    throw new AppError(
      'COMMAND_FAILED',
      'Cannot publish an active-session script containing close.',
      {
        retriable: false,
        hint: 'Close this session and record the journey again from a fresh open --save-script session.',
      },
    );
  }

  let lastMutationIndex = -1;
  for (const [index, action] of actions.entries()) {
    if (
      resolveCommandRecordingEffect({
        command: action.command,
        positionals: action.positionals,
        flags: action.flags,
      }) === 'mutates-app'
    ) {
      lastMutationIndex = index;
    }
  }
  if (actions.slice(lastMutationIndex + 1).some(isPortableDestinationGuard)) return;
  throw new AppError(
    'COMMAND_FAILED',
    'Cannot publish this session without a portable destination guard after the final mutating action.',
    {
      retriable: true,
      hint: 'Record a selector-targeted wait on a labeled or id-bearing landmark, for example wait \'role="heading" label="Screen X"\', so its recorded identity is captured, then retry session save-script.',
    },
  );
}

export function assertActivePublicationPortability(actions: SessionAction[]): void {
  for (const action of actions) {
    if (isRecordedDrag(action)) {
      assertPortableDragBindings(action);
      continue;
    }
    const targetToken = readTargetBindingToken(action);
    const ref = targetToken ?? (action.command === 'wait' ? action.positionals[0] : undefined);
    if (ref?.startsWith('@')) {
      throw new AppError(
        'COMMAND_FAILED',
        `Cannot publish recorded step "${action.command} ${ref}": the session-local ref was not converted to a portable selector.`,
        {
          retriable: false,
          hint: 'Close this session and record the journey again using selectors or resolvable refs.',
        },
      );
    }
    if (action.command === 'find' && resolveCommandRecordingEffect(action) === 'mutates-app') {
      throw new AppError(
        'COMMAND_FAILED',
        'Cannot publish a recorded mutating find step because its target identity is not replay-verifiable.',
        {
          retriable: false,
          hint: 'Close this session and record the journey again with an explicit selector-targeted click, press, fill, or focus action.',
        },
      );
    }
    const token = targetToken;
    if (!token || !isValidSelectorExpression(token) || action.targetEvidence) continue;
    throw new AppError(
      'COMMAND_FAILED',
      `Cannot publish recorded step "${action.command} ${token}": recording-time target identity evidence is missing.`,
      {
        retriable: false,
        hint: 'Close this session and record the journey again from open --save-script so target-v1 evidence is captured before each interaction.',
      },
    );
  }
}

function isRecordedDrag(action: SessionAction): boolean {
  return readRecordedDrag(action) !== undefined;
}

function assertPortableDragBindings(action: SessionAction): void {
  const drag = readRecordedDrag(action);
  if (!drag) return;
  const endpoints = [drag.source, drag.destination];
  for (const endpoint of endpoints) {
    if (endpoint?.startsWith('@')) {
      throw new AppError(
        'COMMAND_FAILED',
        `Cannot publish recorded drag endpoint "${endpoint}": the session-local ref was not converted to a portable selector.`,
        { retriable: false },
      );
    }
    if (!endpoint || !isValidSelectorExpression(endpoint)) continue;
    if (action.targetEvidences) continue;
    throw new AppError(
      'COMMAND_FAILED',
      `Cannot publish recorded drag endpoint "${endpoint}": recording-time target identity evidence is missing.`,
      {
        retriable: false,
        hint: 'Close this session and record the journey again so targets-v1 evidence is captured for both drag endpoints.',
      },
    );
  }
}

function readRecordedDrag(action: SessionAction) {
  return action.command === 'gesture'
    ? dragGesturePayloadFromPositionals(action.positionals)
    : undefined;
}

export function toActivePublicationFailure(
  error: unknown,
  scriptPath: string | undefined,
): AppError {
  if (error instanceof AppError) {
    if (error.details?.reason === 'script_target_exists') {
      return new AppError(error.code, `A file already exists at ${String(error.details.path)}.`, {
        ...error.details,
        retriable: true,
        hint: 'Retry session save-script with another path, or pass --force to replace the existing file. The session remains armed.',
      });
    }
    const retriable = error.details?.retriable === true;
    return new AppError(error.code, error.message, {
      ...error.details,
      retriable,
      hint:
        error.details?.hint ??
        (retriable
          ? 'Fix the recorded journey or target, then retry session save-script. The session remains armed.'
          : 'Close this session and start a fresh one with open <app> --save-script[=<path>].'),
    });
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new AppError(
    'COMMAND_FAILED',
    `Failed to publish the active session script${scriptPath ? ` to ${scriptPath}` : ''}: ${detail}`,
    {
      retriable: true,
      hint: 'Check the target path and permissions, then retry session save-script. The session remains armed.',
    },
  );
}

function isPortableDestinationGuard(action: SessionAction): boolean {
  if (action.command !== 'wait') return false;
  const parsed = parseWaitPositionals(action.positionals);
  if (parsed?.kind !== 'selector' || !isValidSelectorExpression(parsed.selectorExpression)) {
    return false;
  }
  // #1349: a guard proves recorded landmark identity, not bare selector
  // existence — a reshuffled screen containing the same label elsewhere must
  // fail replay closed instead of false-passing. A selector wait recorded
  // without verified evidence (an identity-empty landmark, or a capture
  // anomaly) therefore does not qualify.
  return action.targetEvidence?.verification === 'verified';
}

function readTargetBindingToken(action: SessionAction): string | undefined {
  if (action.command === 'get') return action.positionals[1];
  if (isTouchTargetCommand(action.command) || action.command === 'fill') {
    const [first, second] = action.positionals;
    if (
      first !== undefined &&
      second !== undefined &&
      isFiniteNumber(first) &&
      isFiniteNumber(second)
    ) {
      return undefined;
    }
    return first;
  }
  return undefined;
}

function isFiniteNumber(value: string): boolean {
  return value.trim().length > 0 && Number.isFinite(Number(value));
}
