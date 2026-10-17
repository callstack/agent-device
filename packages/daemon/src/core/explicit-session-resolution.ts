import type { DaemonWireRequest } from '@agent-device/contracts/command';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
import { namesSessionExplicitly } from '@agent-device/kernel/contracts';
import {
  AppError,
  namedSessionNotFoundDetails,
  type RefusalDetails,
} from '@agent-device/kernel/errors';
import { hasDeviceSelectionInput } from './device/device-selector-intent.ts';
import type { SessionState } from './session-state.ts';

/**
 * The answer to a request that names a session this daemon does not hold: the session, not the
 * device, is what is missing, and the command stopped before anything could reach a device.
 */
export function namedSessionNotFoundError(sessionAddress: string): AppError {
  const sessionArg = shellQuoteIfNeeded(sessionAddress);
  return new AppError(
    'SESSION_NOT_FOUND',
    `No active session "${sessionAddress}". Run agent-device open <app> --session ${sessionArg} first, or omit --session to run against a device selector.`,
    {
      ...namedSessionNotFoundDetails(sessionAddress),
      hint:
        'Run agent-device session list to see the sessions this daemon holds. ' +
        "A daemon that was replaced or restarted starts without its predecessor's sessions.",
    } satisfies RefusalDetails<'named_session_not_found'>,
  );
}

/**
 * Refuses a request whose session the daemon does not hold, at the seam where that request would
 * otherwise have had its device chosen from its own selectors.
 *
 * The fall-through this closes is what an unheld session leaves behind. A session-attached command
 * names no device, so resolving one from its flags meant picking from every device on the host:
 * with one booted the caller met an app-session error, with two an `AMBIGUOUS_MATCH` telling it to
 * select a device — an answer that depends on how many devices happen to be up, and that sends the
 * caller after a device selector when what it lost was its session (#3674). Refusing here also skips
 * the device listing the fall-through paid for.
 *
 * Two shapes keep the path they chose: a request that never named a session, which is using the
 * daemon sessionlessly by design, and one that names a device selector as well, which states its
 * target outright and needs no session to supply one. The predicate deciding the first is
 * `namesSessionExplicitly` (`@agent-device/kernel/contracts`), traced from what the request carries
 * rather than from the session string.
 */
export function requireNamedSessionHoldsDevice(
  params: Readonly<{
    req: DaemonWireRequest;
    sessionAddress: string;
    session: SessionState | undefined;
  }>,
): void {
  if (params.session) return;
  if (!namesSessionExplicitly(params.req)) return;
  if (hasDeviceSelectionInput(params.req.flags)) return;
  throw namedSessionNotFoundError(params.sessionAddress);
}
