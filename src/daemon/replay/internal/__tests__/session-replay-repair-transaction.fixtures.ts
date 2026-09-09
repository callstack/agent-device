import path from 'node:path';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import { SessionStore } from '../../../session-store.ts';
import { LeaseRegistry } from '../../../lease-registry.ts';
import {
  makeIosSession,
  makeRepairCompleteSession,
  repairPublication,
} from '../../../../__tests__/test-utils/session-factories.ts';
import { handleSessionCloseCommands as handleProductionCloseCommand } from '../../../session-lifecycle/index.ts';
import {
  bindLifecycleRuntime,
  inspectLifecycleRuntimeFacts,
} from '../../../__tests__/application-lifecycle-runtime-harness.ts';
import { platformResourceCleanup } from '../../../../platform-runtime-resource-cleanup.ts';
import { freshEvidence } from './session-replay-repair.fixtures.ts';

/**
 * ADR 0012 decision 6 "repair transaction" lifecycle fixtures: an id="save" annotation whose
 * target diverges to id="save-v2" under `session-replay-repair-transaction*.test.ts`'s mocked
 * device tree, a fresh sessions dir + registries per test, `close` bound to the production
 * lifecycle runtime seams, and a COMPLETE repair-armed session ready to commit. It lives in its
 * own fixture module, separate from `session-replay-repair.fixtures.ts`, so that sharing it does
 * not pull the `close`-side lifecycle harness (and its `node:timers/promises` mock) into the
 * unrelated repair-loop/acceptance/empty-tail test files that only need
 * `session-replay-repair.fixtures.ts`'s `makeRecordingReplayInvoke`.
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
