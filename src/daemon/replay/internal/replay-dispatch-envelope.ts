import type { SessionScope } from '@agent-device/contracts/session';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { ReplayDispatchOptions } from '@agent-device/contracts/replay';
import { stripUndefined } from '@agent-device/kernel/record';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { ReplayCommand, ReplayDispatchRequest, ReplayInvoke } from './command-types.ts';

/** The request-private facts replay's own decisions read, as the daemon resolves them. */
export type ReplayPrivateAdmission = Readonly<{
  publicNetworkOnly?: true;
  resolvedSessionScope?: SessionScope;
}>;

/**
 * A request as replay reads it: the public wire shape, plus a private half replay never composes
 * and only ever hands back whole. `Private` stays the daemon's own record of that half.
 */
export type ReplayRequest<Private extends ReplayPrivateAdmission> = DaemonWireRequest &
  Readonly<{ internal?: Private }>;

/**
 * The part of a `ReplayCommand` a request answers to: its wire half plus the two admission facts.
 * Drawn from the command itself, so the envelope cannot drift from what the command reads.
 */
export type ReplayCommandEnvelope = Pick<
  ReplayCommand,
  'request' | 'publicNetworkOnly' | 'resolvedSessionScope'
>;

/**
 * Reads a request into the command's public half and the admission facts it may act on. The
 * private half stays where it came from: replay receives this envelope, never the record.
 */
export function splitReplayCommandRequest<Private extends ReplayPrivateAdmission>(
  request: ReplayRequest<Private>,
): ReplayCommandEnvelope {
  const { internal, ...wire } = request;
  return {
    request: wire,
    ...(internal?.publicNetworkOnly ? { publicNetworkOnly: true } : {}),
    ...(internal?.resolvedSessionScope
      ? { resolvedSessionScope: internal.resolvedSessionScope }
      : {}),
  };
}

/**
 * The private half one replay dispatch travels under: the originating request's own facts first,
 * then whatever this dispatch's bag asks for, with the undefined entries stripped. `undefined`
 * when nothing would be carried, so the request keeps no empty private half.
 */
function mergeReplayDispatch<Private extends ReplayPrivateAdmission>(
  base: Private | undefined,
  dispatch: ReplayDispatchOptions | undefined,
): (Private & ReplayDispatchOptions) | undefined {
  const internal = stripUndefined({ ...base, ...dispatch });
  return Object.keys(internal).length > 0
    ? (internal as Private & ReplayDispatchOptions)
    : undefined;
}

/**
 * Dispatches replay's nested requests through a caller-supplied invoke, re-attaching the private
 * half it read from the originating request. Replay never composes that half itself; this is the
 * one place it is folded in, so the merge order is production code and not each caller's copy.
 */
export function replayInvokeOverDispatch<Private extends ReplayPrivateAdmission>(
  invoke: (request: ReplayRequest<Private>) => Promise<DaemonResponse>,
  base: ReplayRequest<Private>,
): ReplayInvoke {
  return async ({ dispatch, ...wire }: ReplayDispatchRequest) => {
    const internal = mergeReplayDispatch(base.internal, dispatch);
    return await invoke(internal ? { ...wire, internal } : wire);
  };
}
