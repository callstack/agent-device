import path from 'node:path';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { isDeviceClaimConflictReason } from '@agent-device/contracts/device';
import type { SessionStore } from '../core/session-store.ts';
import type { SessionState } from '../core/session-state.ts';
import type { DaemonRequest } from '../core/daemon-request.ts';
import { GENERIC_IN_USE_MESSAGE } from '../core/session-recovery-hints.ts';
import { createSessionVisibilityPredicate } from './session-routing.ts';

/** The ownership fields of a host-global device claim that this visibility rule needs. */
export type ClaimOwnerRef = Readonly<{
  session: string;
  workspace: string;
  stateDir: string;
}>;

/**
 * Whether a reply may name `session` to this request. The listing rule decides the common case;
 * the exception is #2580's: a local session of another workspace stays unnamed by the listing yet
 * must keep its address, because that address is the handle its owner uses to close it from that
 * folder. What may never be named is the session of another client on a proxy shared under one
 * token — a leased session, or any tenant-scoped session the request does not already see (#4923).
 */
export function mayNameSession(req: DaemonRequest, session: SessionState): boolean {
  if (createSessionVisibilityPredicate(req)(session)) return true;
  return session.lease === undefined && session.sessionScope?.kind !== 'tenant';
}

/**
 * Whether a reply may name the session a host-global device claim records as its owner.
 *
 * The claim names the state dir of the daemon that wrote it. A claim this daemon wrote is verified
 * only when its session label still resolves in the store and may be named to the request; an
 * expired tenant's unresolvable label gets the generic refusal (#4923). A claim another daemon on
 * this host wrote names a session that is not in this store at all, and naming its recorded owner
 * and workspace is the documented cross-worktree recovery this refusal exists for, so it stays.
 */
export function claimOwnerVisible(
  req: DaemonRequest,
  sessionStore: SessionStore,
  owner: ClaimOwnerRef,
): boolean {
  if (!isSameDaemonStateDir(owner.stateDir, sessionStore.resolveDaemonStateDir())) return true;
  const ref = sessionStore.lookup(owner.session);
  return ref !== undefined && mayNameSession(req, ref.session);
}

/**
 * Answers a claim-conflict refusal without its owner when the owner is an unverified or invisible
 * session of this daemon. The code, typed reason, classification, device fields, recovery command
 * and hint stay; the `owner` detail and the message naming it go.
 */
export function dropInvisibleClaimOwner(
  req: DaemonRequest,
  sessionStore: SessionStore,
  response: DaemonResponse,
): DaemonResponse {
  if (response.ok) return response;
  const { error } = response;
  const details = error.details;
  const owner = readClaimOwner(details?.owner);
  if (
    !isDeviceClaimConflictReason(details?.reason) ||
    owner === undefined ||
    claimOwnerVisible(req, sessionStore, owner)
  ) {
    return response;
  }
  const { owner: _namedOwner, ...anonymousDetails } = details ?? {};
  return {
    ok: false,
    error: { ...error, message: GENERIC_IN_USE_MESSAGE, details: anonymousDetails },
  };
}

function isSameDaemonStateDir(claimStateDir: string, daemonStateDir: string): boolean {
  return path.resolve(claimStateDir) === path.resolve(daemonStateDir);
}

function readClaimOwner(owner: unknown): ClaimOwnerRef | undefined {
  if (typeof owner !== 'object' || owner === null) return undefined;
  const { session, workspace, stateDir } = owner as Record<string, unknown>;
  return typeof session === 'string' &&
    typeof workspace === 'string' &&
    typeof stateDir === 'string'
    ? { session, workspace, stateDir }
    : undefined;
}
