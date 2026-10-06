import { afterEach, expect, test, vi } from 'vitest';
import type { SnapshotOptions } from '@agent-device/contracts/interactor-types';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { makeAndroidSession } from '../../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import { contextFromFlags } from '../../../context.ts';
import { captureSnapshotForSession } from '../../index.ts';

// The interaction runtime's capture (press/click/fill/longpress/hover <selector> --scope X,
// --settle observation) carries the scope in `flags.snapshotScope` only. Android resolves scope
// inside its projection and gets no post-wire pass, so the platform MUST receive that scope; a
// capture that dropped it here would return the unscoped tree with nothing left to notice (#1832
// C2, adversarial review of PR #1846).

const captured = vi.hoisted(() => ({
  options: [] as SnapshotOptions[],
  held: undefined as Promise<void> | undefined,
}));

vi.mock('../../../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(async ({ options }: { options: SnapshotOptions }) => {
    captured.options.push(options);
    await captured.held;
    const nodes = [
      { index: 0, depth: 0, type: 'android.widget.FrameLayout', label: 'Root' },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'android.widget.Button',
        label: 'Save',
        hittable: true,
      },
      { index: 2, depth: 1, parentIndex: 0, type: 'android.view.ViewGroup', identifier: 'panel' },
      {
        index: 3,
        depth: 2,
        parentIndex: 2,
        type: 'android.widget.Button',
        label: 'Save',
        hittable: true,
      },
    ];
    // Scripted platform projection: the Android runtime returns only the scoped subtree.
    const scoped = options.scope
      ? nodes.slice(2).map((n) => ({ ...n, depth: n.depth - 1 }))
      : nodes;
    return { nodes: scoped, backend: 'android' as const };
  }),
}));

afterEach(() => {
  captured.options.length = 0;
  captured.held = undefined;
});

test('interaction captures hand flags.snapshotScope to the Android platform and keep its scoped tree', async () => {
  const sessionStore = makeSessionStore('agent-device-interaction-scope-');
  const session = makeAndroidSession('scope');
  const ref = sessionStore.publish(session.name, session);

  const snapshot = await captureSnapshotForSession(
    ref,
    { snapshotScope: 'panel' },
    sessionStore,
    (flags: CommandFlags | undefined, appBundleId?: string, traceLogPath?: string) =>
      contextFromFlags('/dev/null', flags, appBundleId, traceLogPath),
    { interactiveOnly: true },
  );

  expect(captured.options.map((options) => options.scope)).toEqual(['panel']);
  expect(snapshot.nodes.map((node: SnapshotNode) => node.label ?? node.identifier)).toEqual([
    'panel',
    'Save',
  ]);
});

for (const change of ['rebuild', 'replace'] as const) {
  test(`a held interaction capture respects its scoped lifetime after ${change}`, async () => {
    const sessionStore = makeSessionStore();
    const address = 'cwd:interaction-capture:default';
    const ref = sessionStore.publish(address, makeAndroidSession('default'));
    let release!: () => void;
    captured.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = captureSnapshotForSession(ref, {}, sessionStore, () => ({}), {
      interactiveOnly: true,
    });
    const result = running.then(
      (snapshot) => ({ snapshot }),
      (error: unknown) => ({ error }),
    );
    try {
      await vi.waitFor(() => expect(captured.options).toHaveLength(1));
      if (change === 'rebuild') {
        sessionStore.update(ref, { appName: 'Intervening rebuild' });
        release();
        expect(await result).toHaveProperty('snapshot');
        expect(sessionStore.requireCurrent(ref).appName).toBe('Intervening rebuild');
        expect(sessionStore.requireCurrent(ref).snapshot?.nodes).toHaveLength(4);
      } else {
        sessionStore.retire(ref);
        const successor = sessionStore.publish(
          address,
          makeAndroidSession('default', { appName: 'Successor' }),
        );
        release();
        expect(await result).toMatchObject({
          error: { details: { reason: 'session_lifetime_ended' } },
        });
        expect(sessionStore.requireCurrent(successor)).toBe(successor.session);
        expect(successor.session.snapshot).toBeUndefined();
      }
      expect(sessionStore.get('default')).toBeUndefined();
    } finally {
      release();
      await result;
    }
  });
}
