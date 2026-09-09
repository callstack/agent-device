import { isSessionRecording } from '../../../session-script-publication-capability.ts';
/**
 * Shared fixtures for the ADR 0012 decision 6 repair-loop tests. The mock
 * `invoke` in these tests must ACTUALLY record via `sessionStore.recordAction`
 * (the same call the real command handlers make) so `session.actions`
 * accumulates for real — the whole mechanism is "the healed script IS
 * session.actions." This factory keeps the per-test mock declarative (a config
 * object, no inline branching) so each test body stays linear.
 */
import path from 'node:path';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../../../daemon-request.ts';
import { SessionStore } from '../../../session-store.ts';
import { LeaseRegistry } from '../../../lease-registry.ts';
import { isInteractiveObservation } from '../../../session-action-recorder.ts';
import {
  makeIosSession,
  makeRepairCompleteSession,
  repairPublication,
} from '../../../../__tests__/test-utils/session-factories.ts';
import type { TargetAnnotationV1 } from '@agent-device/contracts/replay';
import { handleSessionCloseCommands as handleProductionCloseCommand } from '../../../session-lifecycle/index.ts';
import {
  bindLifecycleRuntime,
  inspectLifecycleRuntimeFacts,
} from '../../../__tests__/application-lifecycle-runtime-harness.ts';
import { platformResourceCleanup } from '../../../../platform-runtime-resource-cleanup.ts';

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
   * the session is recording (mirrors `interaction-common.ts`). The
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
    const evidence = isSessionRecording(session) ? config.evidence?.(req) : undefined;
    sessionStore.recordAction(session, {
      command: req.command,
      positionals: req.positionals ?? [],
      flags: req.flags ?? {},
      runtime: req.runtime,
      result: {},
      // #1271 stage 2: the PRODUCTION classifier, not a mirror of it — this
      // mock stands in for the real handlers' recording call, so it must make
      // the same interactive-vs-authored decision they do. It reads
      // `internal.replayPlanStep`, which the real `invokeReplayAction` stamps
      // on every plan step, so a replayed observation is correctly treated as
      // authored here without the fixture knowing anything about provenance.
      interactiveObservation: isInteractiveObservation(req),
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

/**
 * ADR 0012 decision 6 "repair transaction" lifecycle fixtures: an id="save" annotation whose
 * target diverges to id="save-v2" under `session-replay-repair-transaction*.test.ts`'s mocked
 * device tree, a fresh sessions dir + registries per test, `close` bound to the production
 * lifecycle runtime seams, and a COMPLETE repair-armed session ready to commit. It lives here
 * rather than in any one `session-replay-repair-transaction*.test.ts` file because several split
 * test files over the module-size tripwire share it (docs/agents/testing.md).
 */
export const SAVE_ANNOTATION =
  '# agent-device:target-v1 {"id":"save","role":"button","label":"Save","ancestry":[],"sibling":0,"viewportOrder":0,"verification":"verified"}';

export function setup(prefix: string) {
  const root = mkdtempForTestSync(prefix);
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  return {
    root,
    sessionStore,
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    leaseRegistry: new LeaseRegistry(),
  };
}

export function handleCloseCommand(
  params: Omit<Parameters<typeof handleProductionCloseCommand>[0], 'inspectFacts' | 'bindDevice'>,
) {
  return handleProductionCloseCommand({
    ...params,
    platformResourceCleanup,
    inspectFacts: inspectLifecycleRuntimeFacts,
    bindDevice: bindLifecycleRuntime,
  });
}

/** A COMPLETE, committable repair-armed session at the default healed sibling path. */
export function makeCompleteRepairSession(
  sessionStore: SessionStore,
  sessionName: string,
  root: string,
) {
  const session = makeRepairCompleteSession(sessionName, {
    appBundleId: 'com.example.app',
    scriptPublication: repairPublication('complete', { path: path.join(root, 'flow.healed.ad') }),
    actions: [
      { ts: 1, command: 'open', positionals: ['Demo'], flags: {} },
      {
        ts: 2,
        command: 'press',
        positionals: ['@e7'],
        flags: {},
        result: { selectorChain: ['id="save-v2"'] },
        targetEvidence: freshEvidence('save-v2', 'Save V2'),
      },
    ],
  });
  sessionStore.set(sessionName, session);
  return session;
}
