import { test, expect } from 'vitest';
import {
  attachRefs,
  type IosTargetActivation,
  type SnapshotState,
} from '@agent-device/kernel/snapshot';
import { iosTargetActivationDisclosure } from '@agent-device/contracts/ios-target-activation';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import { handleInteractionCommands } from '../../index.ts';
import { getRuntimeBindings } from '../../../__tests__/interaction-get-runtime-fixture.ts';
import { contextFromFlags, makeSession } from './interaction-touch-fixtures.ts';

const FACT: IosTargetActivation = {
  reason: 'stale_target',
  priorState: 'runningBackground',
  otherActiveApplicationPid: 4562,
};

function capturedTree(params: {
  sessionName: string;
  targetActivation?: IosTargetActivation;
}): SnapshotState {
  return {
    nodes: attachRefs([
      { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
      {
        index: 1,
        parentIndex: 0,
        depth: 1,
        type: 'Cell',
        label: 'General',
        rect: { x: 16, y: 293, width: 370, height: 52 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
    ...(params.targetActivation ? { targetActivation: params.targetActivation } : {}),
  };
}

async function pressSelector(params: {
  sessionName: string;
  capture: SnapshotState;
  captureCalls: { count: number };
}) {
  const sessionStore = makeSessionStore();
  sessionStore.set(params.sessionName, makeSession(params.sessionName));
  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: params.sessionName,
      command: 'press',
      positionals: ['label="General"'],
      flags: {},
    },
    sessionName: params.sessionName,
    sessionStore,
    contextFromFlags,
    captureSnapshotForSession: async () => {
      params.captureCalls.count += 1;
      return params.capture;
    },
    ...getRuntimeBindings(),
  });
  return { response, stored: sessionStore.get(params.sessionName) };
}

/**
 * The interaction's target tree is the thing an agent believes it tapped. When the runner had to
 * re-activate the session app to serve that tree, the press response must say so (#2682).
 */
test('a press whose target capture repaired foreground discloses the repair', async () => {
  const captureCalls = { count: 0 };
  const { response } = await pressSelector({
    sessionName: 'default',
    capture: capturedTree({ sessionName: 'default', targetActivation: FACT }),
    captureCalls,
  });

  expect(captureCalls.count).toBeGreaterThan(0);
  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.warnings).toEqual([iosTargetActivationDisclosure(FACT)]);
    expect(response.data?.targetActivation).toEqual(FACT);
  }
});

/**
 * A press answered from the stored ref frame consumes no capture, so this request paid no
 * foreground repair. An older capture's fact must not be attributed to it.
 */
test('a press that consumes no capture is not disclosed against an older tree', async () => {
  const captureCalls = { count: 0 };
  const sessionName = 'default';
  const sessionStore = makeSessionStore();
  const session = makeSession(sessionName);
  session.snapshot = capturedTree({ sessionName, targetActivation: FACT });
  sessionStore.set(sessionName, session);

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['@e2'],
      flags: {},
    },
    sessionName,
    sessionStore,
    contextFromFlags,
    captureSnapshotForSession: async () => {
      captureCalls.count += 1;
      return capturedTree({ sessionName });
    },
    ...getRuntimeBindings(),
  });

  expect(captureCalls.count).toBe(0);
  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.warnings).toBeUndefined();
    expect(response.data?.targetActivation).toBeUndefined();
  }
});
