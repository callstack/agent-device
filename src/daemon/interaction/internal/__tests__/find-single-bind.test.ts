import { test, expect, vi, beforeEach } from 'vitest';
import type { DaemonResponse } from '../../../types.ts';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import { makeIosSession } from '../../../../__tests__/test-utils/session-factories.ts';
import {
  mockFocusPoint,
  mockTypeText,
  resetGetRuntimeFixture,
  runtimeBindingSpies,
} from '../../../__tests__/interaction-get-runtime-fixture.ts';
import { invokeFindHandler } from './find-handler-fixture.ts';
import { legacyDispatchCapture } from '../../../__tests__/legacy-snapshot-capture-fixture.ts';

vi.mock('../../../snapshot-interactor-capture.ts', async () => {
  const fixture = await import('../../../__tests__/legacy-snapshot-capture-fixture.ts');
  return { captureSnapshotWithInteractor: fixture.captureSnapshotThroughLegacyDispatchFixture };
});

beforeEach(() => {
  resetGetRuntimeFixture();
  legacyDispatchCapture.mockReset();
});

async function runMutatingFind(positionals: string[], node: Record<string, unknown>) {
  const sessionStore = makeSessionStore();
  const sessionName = 'default';
  const session = makeIosSession(sessionName);
  sessionStore.set(sessionName, session);
  legacyDispatchCapture.mockImplementation(async (_device, command) =>
    command === 'snapshot' ? { nodes: [node] } : {},
  );
  return await invokeFindHandler({
    sessionName,
    sessionStore,
    positionals,
    invoke: async () => ({ ok: true, data: {} }) as DaemonResponse,
  });
}

test('find focus performs exactly one facts inspection and one bind (ADR 0019 §9)', async () => {
  const response = await runMutatingFind(['Save', 'focus'], {
    index: 0,
    ref: 'e1',
    type: 'Button',
    label: 'Save',
    hittable: true,
    rect: { x: 10, y: 20, width: 100, height: 40 },
  });

  expect(response?.ok).toBe(true);
  expect(mockFocusPoint).toHaveBeenCalledTimes(1);
  const spies = runtimeBindingSpies();
  expect(spies.inspectFacts).toHaveBeenCalledTimes(1);
  expect(spies.bindDevice).toHaveBeenCalledTimes(1);
});

test('find type performs exactly one facts inspection and one bind (ADR 0019 §9)', async () => {
  const response = await runMutatingFind(['Email', 'type', 'ada@example.test'], {
    index: 0,
    ref: 'e1',
    type: 'TextField',
    label: 'Email',
    hittable: true,
    rect: { x: 10, y: 20, width: 200, height: 40 },
  });

  expect(response?.ok).toBe(true);
  // The one bind carried both legs: the focus tap and the text entry.
  expect(mockFocusPoint).toHaveBeenCalledTimes(1);
  expect(mockTypeText).toHaveBeenCalledTimes(1);
  expect(mockTypeText).toHaveBeenCalledWith(expect.objectContaining({ text: 'ada@example.test' }));
  const spies = runtimeBindingSpies();
  expect(spies.inspectFacts).toHaveBeenCalledTimes(1);
  expect(spies.bindDevice).toHaveBeenCalledTimes(1);
});
