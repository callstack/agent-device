import { dispatchCommand } from '../../core/dispatch.ts';
import type { SessionState } from '../types.ts';
import type { ContextFromFlags } from './interaction-common.ts';
import type { CommandFlags } from '@agent-device/contracts/command';
import { elementTextRead } from '@agent-device/contracts/platform';
import type { ReadElementTextAtPoint } from './interaction-read.ts';

/**
 * The legacy `read` dispatch, adapted to the neutral point-read shape.
 *
 * OWNED DEBT, with a named retirement trigger (#1739): `readText` on the shared selector backend
 * serves `get text` and read-only `find … get text`. `get` is migrated and passes its bound
 * `readTextAtPoint` instead of this adapter; `find` is a separate unit and still reaches the
 * platform through the `read` dispatch alias. This module, the `read` registry entry, its
 * `dispatch: {}` projection, `DISPATCH_HANDLERS.read`, and `handleReadCommand` all retire
 * together in the unit that migrates `find`'s read-only path — the last selector-read consumer.
 *
 * It is not a fallback: no command chooses between this and a bound operation. Which one the
 * shared backend receives is fixed by whether the calling command has cut over.
 */
export function legacyDispatchReadTextAtPoint(params: {
  device: SessionState['device'];
  flags: CommandFlags | undefined;
  surface?: SessionState['surface'];
  contextFromFlags: ContextFromFlags;
}): ReadElementTextAtPoint {
  return async (input) => {
    const rawData = await dispatchCommand(
      params.device,
      'read',
      [String(input.point.x), String(input.point.y)],
      undefined,
      {
        ...params.contextFromFlags(
          params.flags,
          input.options?.appBundleId,
          input.execution?.traceLogPath,
        ),
        surface: params.surface,
      },
    );
    const data = rawData && typeof rawData === 'object' ? rawData : undefined;
    return elementTextRead(typeof data?.text === 'string' ? data.text : undefined);
  };
}
