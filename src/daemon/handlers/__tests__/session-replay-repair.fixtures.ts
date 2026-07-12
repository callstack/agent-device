/**
 * Shared fixtures for the ADR 0012 decision 6 repair-loop tests. The mock
 * `invoke` in these tests must ACTUALLY record via `sessionStore.recordAction`
 * (the same call the real command handlers make) so `session.actions`
 * accumulates for real — the whole mechanism is "the healed script IS
 * session.actions." This factory keeps the per-test mock declarative (a config
 * object, no inline branching) so each test body stays linear.
 */
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../../types.ts';
import { SessionStore } from '../../session-store.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import type { TargetAnnotationV1 } from '../../../replay/target-identity.ts';

export function freshEvidence(id: string, label: string): TargetAnnotationV1 {
  return {
    id,
    role: 'button',
    label,
    ancestry: [],
    sibling: 0,
    viewportOrder: 0,
    verification: 'verified',
  };
}

export type RecordingReplayInvokeConfig = {
  sessionStore: SessionStore;
  sessionName: string;
  /** Records every request seen, in order — for asserting dispatch order/flags. */
  spy?: DaemonRequest[];
  /**
   * When true, `open` REPLACES the session with a fresh `actions: []` one —
   * mimicking `session-open-surface.ts`'s new-session branch. Default records
   * onto the existing session (creating one only if none exists yet).
   */
  openReplacesSession?: boolean;
  /**
   * Steps that fail: return `{ ok: false }` WITHOUT recording — mimicking a
   * dispatch failure that never reaches `finalizeTouchInteraction`. Keyed by
   * `"<command> <positional0>"` or by bare `<command>`.
   */
  failSteps?: ReadonlySet<string>;
  /**
   * Fresh `target-v1` evidence attached to a recorded step, but ONLY when
   * `session.recordSession` is armed (mirrors `interaction-common.ts`). The
   * caller decides which steps carry evidence.
   */
  evidence?: (req: DaemonRequest) => TargetAnnotationV1 | undefined;
};

export function makeRecordingReplayInvoke(config: RecordingReplayInvokeConfig): DaemonInvokeFn {
  const { sessionStore } = config;
  return async (req: DaemonRequest): Promise<DaemonResponse> => {
    config.spy?.push(req);
    if (isFailStep(config.failSteps, req)) {
      return { ok: false, error: { code: 'COMMAND_FAILED', message: 'not hittable' } };
    }
    const session = resolveInvokeSession(config, req);
    const evidence = session.recordSession ? config.evidence?.(req) : undefined;
    sessionStore.recordAction(session, {
      command: req.command,
      positionals: req.positionals ?? [],
      flags: req.flags ?? {},
      runtime: req.runtime,
      result: {},
      ...(evidence ? { targetEvidence: evidence } : {}),
    });
    return { ok: true, data: {} };
  };
}

function isFailStep(failSteps: ReadonlySet<string> | undefined, req: DaemonRequest): boolean {
  if (!failSteps) return false;
  const key = `${req.command} ${req.positionals?.[0] ?? ''}`.trim();
  return failSteps.has(key) || failSteps.has(req.command);
}

function resolveInvokeSession(config: RecordingReplayInvokeConfig, req: DaemonRequest) {
  const existing = config.sessionStore.get(config.sessionName);
  const mustCreate = req.command === 'open' && (config.openReplacesSession || !existing);
  if (!mustCreate && existing) return existing;
  const created = makeIosSession(config.sessionName);
  config.sessionStore.set(config.sessionName, created);
  return created;
}
