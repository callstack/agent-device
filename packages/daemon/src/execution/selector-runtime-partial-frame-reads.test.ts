import { test, expect, vi, beforeEach } from 'vitest';
import {
  legacyDispatchCapture,
  resetLegacySnapshotCapture,
} from '../__tests__/support/legacy-snapshot-capture-fixture.ts';
import { attachRefs } from '@agent-device/kernel/snapshot';
import { makeSessionStore } from '../__tests__/support/store-factory.ts';
import { activateCompleteRefFrame } from '../core/ref-frame.ts';
import {
  installInteractorSnapshotResolution,
  mockInteractorSnapshot,
} from '../__tests__/support/interactor-resolution-fixture.ts';
import {
  createTouchCommandSurface,
  touchCreateCommandSurface,
} from '../__tests__/support/touch-command-surface-fake.ts';
import { captureAndStoreSnapshot } from '../__tests__/support/command-surface-override-fake.ts';
import type { DaemonFindOptions } from '@agent-device/contracts/daemon-command-surface';
import { handleInteractionCommands } from './interaction/index.ts';
import {
  contextFromFlags,
  makeSession,
} from './interaction/internal/__tests__/interaction-touch-fixtures.ts';
import { invokeFindHandler } from './interaction/internal/__tests__/find-handler-fixture.ts';
import {
  getRuntimeBindings,
  resetGetRuntimeFixture,
} from './__tests__/interaction-get-runtime-fixture.ts';

// #4686 / ADR 0014 "Partial issuance": a read-only `find` that prints a ref activates a partial
// frame over its own capture. A ref from the earlier `snapshot -i` was minted from a different
// tree, so a read of it must refuse instead of binding whatever node now holds that number.

const { mockRunAppleRunnerCommand } = vi.hoisted(() => ({
  mockRunAppleRunnerCommand: vi.fn(),
}));

vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return { ...actual, runAppleRunnerCommand: mockRunAppleRunnerCommand };
});

beforeEach(() => {
  installInteractorSnapshotResolution();
  resetLegacySnapshotCapture(mockInteractorSnapshot);
  mockRunAppleRunnerCommand.mockReset();
  mockRunAppleRunnerCommand.mockResolvedValue({});
  resetGetRuntimeFixture();
});

/** The `snapshot -i` tree the caller holds refs for: `@e2` is the item counter. */
function interactiveTree() {
  return attachRefs([
    { index: 0, depth: 0, type: 'Application', label: 'MultiTodo' },
    { index: 1, depth: 1, parentIndex: 0, type: 'StaticText', label: '4 items' },
    { index: 2, depth: 1, parentIndex: 0, type: 'Cell', label: 'Speakers (4)' },
  ]);
}

/** The full capture find reads: `e2` is now a keyboard key, not the counter. */
function fullCapture() {
  return {
    nodes: [
      { index: 0, depth: 0, type: 'Application', label: 'MultiTodo' },
      { index: 1, depth: 1, parentIndex: 0, type: 'Key', label: 'Q' },
      { index: 2, depth: 1, parentIndex: 0, type: 'StaticText', label: '4 items' },
      { index: 3, depth: 1, parentIndex: 0, type: 'Cell', label: 'Speakers (4)' },
    ],
    backend: 'xctest',
    producer: 'apple-runner',
  };
}

/**
 * Read-only `find get text` as the command family answers it: one capture stored as the session
 * snapshot, and the matched node's ref minted from that capture. Text and selector queries both
 * name the "Speakers (4)" cell here; the daemon's issuance is what these cases pin.
 */
const findSurface = createTouchCommandSurface({
  members: (config) => ({
    selectors: {
      find: async (options: DaemonFindOptions) => {
        const snapshot = await captureAndStoreSnapshot(config, options);
        const node = snapshot.nodes.find((candidate) => candidate.label === 'Speakers (4)')!;
        return { kind: 'text' as const, ref: `@${node.ref}`, text: node.label!, node };
      },
    },
  }),
});

async function getText(
  sessionStore: ReturnType<typeof makeSessionStore>,
  sessionName: string,
  ref: string,
) {
  return await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    req: {
      token: 't',
      session: sessionName,
      command: 'get',
      positionals: ['text', ref],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });
}

for (const query of [
  ['Speakers', 'get', 'text'],
  ['label="Speakers (4)"', 'get', 'text'],
]) {
  test(`a ref from the earlier snapshot is refused, not misread, after find ${query[0]} get text`, async () => {
    const sessionStore = makeSessionStore();
    const sessionName = `partial-frame-${query[0]}`;
    const session = makeSession(sessionName);
    session.snapshot = {
      nodes: interactiveTree(),
      createdAt: Date.now(),
      backend: 'xctest',
      producer: 'apple-runner',
    };
    activateCompleteRefFrame(session);
    sessionStore.publish(sessionName, session);
    legacyDispatchCapture.mockResolvedValue(fullCapture());

    const found = await invokeFindHandler({
      createCommandSurface: findSurface,
      sessionName,
      sessionStore,
      positionals: query,
      invoke: async () => ({ ok: true, data: {} }),
    });
    expect(found?.ok).toBe(true);
    const printed = found?.ok ? (found.data?.ref as string) : undefined;
    expect(printed).toBe('@e4');

    // `@e2` was the counter in the caller's snapshot; the find's tree has a key there.
    const stale = await getText(sessionStore, sessionName, '@e2');
    expect(stale?.ok).toBe(false);
    if (!stale || stale.ok) throw new Error('expected the unissued-ref refusal');
    expect(stale.error.details?.reason).toBe('ref_not_issued');

    // The ref the find printed still reads the node it read.
    const issued = await getText(sessionStore, sessionName, printed!);
    expect(issued?.ok).toBe(true);
    if (issued?.ok) expect(issued.data?.text).toBe('Speakers (4)');
  });
}
