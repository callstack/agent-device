import { resolveCommandRecordingEffect } from '../core/command-descriptor/registry.ts';
import { parseWaitPositionals } from '../core/wait-positionals.ts';
import { AppError } from '../kernel/errors.ts';
import { isTouchTargetCommand } from '../replay/script-utils.ts';
import { tryParseSelectorChain } from '../selectors/parse.ts';
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
      hint: 'Record a selective selector-targeted wait, for example wait \'role="heading" label="Screen X"\', then retry session save-script.',
    },
  );
}

export function assertActivePublicationPortability(actions: SessionAction[]): void {
  for (const action of actions) {
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
    if (!token || !tryParseSelectorChain(token) || action.targetEvidence) continue;
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
  return parsed?.kind === 'selector' && tryParseSelectorChain(parsed.selectorExpression) !== null;
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
