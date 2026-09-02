import path from 'node:path';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';
import { makeIosAppSession } from '../../../../__tests__/test-utils/session-factories.ts';
import { SessionStore } from '../../../session-store.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../../../types.ts';
import { runReplayForTest } from '../../__tests__/replay-command-fixture.ts';
import {
  baseReplayRequest,
  writeReplayFile,
} from '../../__tests__/session-replay-runtime.fixtures.ts';

/** A temp root with one seeded session in its store: the ground every replay scenario stands on. */
type ReplaySessionScene = Readonly<{
  root: string;
  sessionStore: SessionStore;
  sessionName: string;
  logPath: string;
}>;

function iosReplayScene(prefix: string): ReplaySessionScene {
  const root = mkdtempForTestSync(prefix);
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosAppSession(sessionName));
  return { root, sessionStore, sessionName, logPath: path.join(root, 'daemon.log') };
}

export type ReplayScriptScene = ReplaySessionScene &
  Readonly<{
    filePath: string;
    /** Every request the replay handed to `invoke`, in dispatch order. */
    invoked: DaemonRequest[];
    /**
     * Runs the script through `runReplayCommand`. Each request is appended to
     * `invoked` before `invoke` answers it; without `invoke` every request succeeds
     * with empty data.
     */
    replay(options?: { invoke?: DaemonInvokeFn }): Promise<DaemonResponse>;
  }>;

/** An iOS app session plus a written `.ad` script, ready to replay. */
export function replayScriptScene(prefix: string, lines: string[]): ReplayScriptScene {
  const scene = iosReplayScene(prefix);
  const filePath = writeReplayFile(scene.root, lines);
  const invoked: DaemonRequest[] = [];
  return {
    ...scene,
    filePath,
    invoked,
    replay: ({ invoke } = {}) =>
      runReplayForTest({
        req: baseReplayRequest({ positionals: [filePath] }),
        sessionName: scene.sessionName,
        logPath: scene.logPath,
        sessionStore: scene.sessionStore,
        invoke: async (req) => {
          invoked.push(req);
          return invoke ? invoke(req) : { ok: true, data: {} };
        },
      }),
  };
}

export const SAVE_ANNOTATION =
  '# agent-device:target-v1 {"id":"save","role":"button","label":"Save","ancestry":[],"sibling":0,"viewportOrder":0,"verification":"verified"}';

export const UNVERIFIABLE_ANNOTATION =
  '# agent-device:target-v1 {"id":"save","role":"button","label":"Save","ancestry":[],"sibling":0,"viewportOrder":0,"verification":"unverifiable"}';

export const WAIT_ANNOTATION =
  '# agent-device:target-v1 {"role":"statictext","label":"Screen X","ancestry":[{"role":"other","label":"Detail Screen"}],"sibling":0,"viewportOrder":0,"verification":"verified"}';

export const WAIT_UNVERIFIABLE_ANNOTATION =
  '# agent-device:target-v1 {"role":"statictext","label":"Screen X","ancestry":[{"role":"other","label":"Detail Screen"}],"sibling":0,"viewportOrder":0,"verification":"unverifiable"}';

export const DRAG_ANNOTATION = `# agent-device:targets-v1 ${JSON.stringify({
  source: {
    id: 'source',
    role: 'view',
    label: 'Source',
    ancestry: [],
    sibling: 0,
    viewportOrder: 0,
    verification: 'verified',
  },
  destination: {
    id: 'destination',
    role: 'view',
    label: 'Drop',
    ancestry: [],
    sibling: 1,
    viewportOrder: 0,
    verification: 'verified',
  },
})}`;

export const DRAG_NODES = [
  {
    index: 0,
    depth: 0,
    type: 'View',
    identifier: 'source',
    label: 'Source',
    rect: { x: 10, y: 10, width: 40, height: 20 },
  },
  {
    index: 1,
    depth: 0,
    type: 'View',
    identifier: 'destination',
    label: 'Drop',
    rect: { x: 100, y: 100, width: 40, height: 20 },
  },
];

/** An XCTest capture holding one "Save" button; `identifier` renames it (`'save-v2'` = renamed id, same label). */
export function saveButtonCapture(identifier = 'save') {
  return {
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        identifier,
        label: 'Save',
        rect: { x: 10, y: 10, width: 40, height: 20 },
      },
    ],
    truncated: false,
    backend: 'xctest',
  };
}

/** An XCTest capture of an entirely empty tree: nothing matches any recorded selector. */
export function emptyCapture() {
  return { nodes: [], truncated: false, backend: 'xctest' };
}
