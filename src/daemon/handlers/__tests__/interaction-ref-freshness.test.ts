import { expect, test, vi } from 'vitest';
import {
  makeIosSession,
  makeSessionStore,
  makeSnapshotState,
} from '../../../__tests__/test-utils/index.ts';
import { AppError } from '../../../kernel/errors.ts';
import { buildSnapshotPresentationKey, type RawSnapshotNode } from '../../../kernel/snapshot.ts';
import type { InteractionHandlerParams } from '../interaction-common.ts';
import { validateStaleIosRefBeforeTouch } from '../interaction-ref-freshness.ts';
import type { CaptureSnapshotForSession } from '../interaction-snapshot.ts';

const CONTINUE: RawSnapshotNode = {
  index: 1,
  parentIndex: 0,
  type: 'Button',
  label: 'Continue',
  rect: { x: 100, y: 300, width: 200, height: 44 },
  hittable: true,
};

const CANCEL: RawSnapshotNode = {
  index: 2,
  parentIndex: 0,
  type: 'Button',
  label: 'Cancel',
  rect: { x: 100, y: 400, width: 200, height: 44 },
  hittable: true,
};

const APPLICATION: RawSnapshotNode = {
  index: 0,
  type: 'Application',
  label: 'Example',
  rect: { x: 0, y: 0, width: 400, height: 800 },
};

test('stale iOS ref probe mirrors the stored positional-ref presentation', async () => {
  const presentation = { interactiveOnly: false, depth: 4, scope: 'Panel', raw: true };
  const fullSnapshot = makeSnapshotState([APPLICATION, CONTINUE, CANCEL], {
    backend: 'xctest',
    presentationKey: buildSnapshotPresentationKey(presentation),
  });
  const interactiveSnapshot = makeSnapshotState([CONTINUE, CANCEL], {
    backend: 'xctest',
    presentationKey: buildSnapshotPresentationKey({ interactiveOnly: true }),
  });
  const session = makeIosSession('stored-presentation', {
    snapshot: fullSnapshot,
    snapshotRefsStale: true,
  });
  const capture = vi.fn<CaptureSnapshotForSession>(async (...args) => {
    const flags = args[1];
    const options = args[4];
    expect(flags).toMatchObject({
      snapshotDepth: 4,
      snapshotInteractiveOnly: false,
      snapshotRaw: true,
      snapshotScope: 'Panel',
    });
    expect(options).toMatchObject({
      interactiveOnly: false,
      includeRects: true,
      store: false,
    });
    return flags?.snapshotInteractiveOnly === false ? fullSnapshot : interactiveSnapshot;
  });

  const response = await validateStaleIosRefBeforeTouch({
    handler: makeHandler(capture),
    session,
    target: { kind: 'ref', ref: '@e2' },
    staleRefsWarning: 'stale',
  });

  expect(response).toBeNull();
  expect(capture).toHaveBeenCalledOnce();
});

test('stale iOS ref probe tolerates established sub-pixel rect drift', async () => {
  const storedSnapshot = makeSnapshotState([CONTINUE], {
    backend: 'xctest',
    presentationKey: buildSnapshotPresentationKey({ interactiveOnly: true }),
  });
  const currentSnapshot = makeSnapshotState(
    [
      {
        ...CONTINUE,
        rect: { x: 100.5, y: 300.5, width: 200, height: 44 },
      },
    ],
    {
      backend: 'xctest',
      presentationKey: buildSnapshotPresentationKey({ interactiveOnly: true }),
    },
  );
  const session = makeIosSession('sub-pixel-drift', {
    snapshot: storedSnapshot,
    snapshotRefsStale: true,
  });
  const capture = vi.fn<CaptureSnapshotForSession>(async () => currentSnapshot);

  const response = await validateStaleIosRefBeforeTouch({
    handler: makeHandler(capture),
    session,
    target: { kind: 'ref', ref: '@e1' },
    staleRefsWarning: 'stale',
  });

  expect(response).toBeNull();
});

test('stale iOS ref validation fails closed when its probe cannot capture', async () => {
  const snapshot = makeSnapshotState([CONTINUE], {
    backend: 'xctest',
    presentationKey: buildSnapshotPresentationKey({ interactiveOnly: true }),
  });
  const session = makeIosSession('capture-failure', {
    snapshot,
    snapshotRefsStale: true,
  });
  const capture = vi.fn<CaptureSnapshotForSession>(async () => {
    throw new AppError('COMMAND_FAILED', 'snapshot probe failed');
  });

  const response = await validateStaleIosRefBeforeTouch({
    handler: makeHandler(capture),
    session,
    target: { kind: 'ref', ref: '@e1' },
    staleRefsWarning: 'stale',
  });

  expect(response).toMatchObject({
    ok: false,
    error: { code: 'COMMAND_FAILED', message: 'snapshot probe failed' },
  });
});

function makeHandler(
  captureSnapshotForSession: CaptureSnapshotForSession,
): InteractionHandlerParams & {
  captureSnapshotForSession: CaptureSnapshotForSession;
} {
  return {
    req: { token: 'test', session: 'freshness', command: 'press', positionals: [], flags: {} },
    sessionName: 'freshness',
    sessionStore: makeSessionStore(),
    contextFromFlags: () => ({ requestId: 'test' }),
    captureSnapshotForSession,
  };
}
