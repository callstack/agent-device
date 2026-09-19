import type { ReplayObservationAuthorityBinder } from '@agent-device/contracts/replay';
import type {
  ReplayCoordinator,
  ReplaySession,
  ReplaySessionObservation,
  ReplaySessionState,
  ReplaySessionStore,
} from './command-types.ts';

/**
 * The live session record reached through the reads replay binds over. The daemon implements it
 * over its locked `SessionStore`; replay binds a session from it and never names the record or
 * the store behind it.
 */
export type ReplaySessionContainer = Readonly<{
  get: () => ReplaySessionState | undefined;
  lookup: () => Readonly<{ address: string; session: ReplaySessionState }> | undefined;
  getRuntimeHints: ReplaySessionStore['getRuntimeHints'];
  ensureSessionDir: ReplaySessionStore['ensureSessionDir'];
}>;

/** The daemon policy the bound session consults without owning. */
export type ReplaySessionPolicy = Readonly<{
  /** The repair-transaction gateway the daemon owns over its own full session record. */
  createCoordinator: () => ReplayCoordinator;
  assertSelectorMatches: ReplaySessionStore['assertSelectorMatches'];
  resolveOpenRuntimeHints: ReplaySessionStore['resolveOpenRuntimeHints'];
  bindAuthority: ReplayObservationAuthorityBinder;
  capture: ReplaySessionObservation['capture'];
}>;

/**
 * Binds one session's replay capabilities: the store view the command reads, the observation
 * capture and ref-publication authority, and the daemon's repair gateway. Every daemon fact
 * arrives through `container` or `policy`, so the binding is the port's own mechanics while the
 * daemon keeps the policy it draws on.
 */
export function bindReplaySession(
  name: string,
  logPath: string,
  container: ReplaySessionContainer,
  policy: ReplaySessionPolicy,
): ReplaySession {
  const { get } = container;
  return {
    name,
    logPath,
    store: {
      get,
      lookup: container.lookup,
      getRuntimeHints: container.getRuntimeHints,
      ensureSessionDir: container.ensureSessionDir,
      assertSelectorMatches: policy.assertSelectorMatches,
      resolveOpenRuntimeHints: policy.resolveOpenRuntimeHints,
    },
    observationStore: {
      get,
      bindAuthority: policy.bindAuthority,
      capture: policy.capture,
    },
    coordinator: policy.createCoordinator(),
  };
}
