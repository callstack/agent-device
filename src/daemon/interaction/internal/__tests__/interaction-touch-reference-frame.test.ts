import { expect, test, vi } from 'vitest';
import { makeSnapshotState } from '@agent-device/capture-kit/snapshot-state-fixtures';
import {
  makeAndroidSession,
  makeIosAppSession,
} from '../../../../__tests__/test-utils/session-factories.ts';
import { makeTestScreenRecordingResource } from '../../../../__tests__/test-utils/screen-recording-live-handle.ts';
import { makeSessionStore } from '../../../../__tests__/test-utils/store-factory.ts';
import { clearAndroidObservationFixture } from '../../../__tests__/android-observation-fixture.ts';
import { contextFromFlags } from './interaction-touch-fixtures.ts';
import { resolveDirectTouchReferenceFrameSafely } from '../interaction-touch-reference-frame.ts';

function holdProbe<T>(result: T) {
  let start!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    release,
    read: vi.fn(async () => {
      start();
      await held;
      return result;
    }),
  };
}

test.each(
  (['android', 'ios'] as const).flatMap((platform) =>
    (['none', 'rebuild', 'retire-and-republish', 'replace-recording'] as const).map((change) => ({
      platform,
      change,
    })),
  ),
)(
  '$platform frame probe after $change writes only to its current recording resource',
  async ({ platform, change }) => {
    const store = makeSessionStore();
    const session = { android: makeAndroidSession, ios: makeIosAppSession }[platform]('default');
    const resource = makeTestScreenRecordingResource(session);
    session.screenRecording = resource;
    const ref = store.publish(`cwd:frame-${platform}-${change}:default`, session);
    const snapshot = makeSnapshotState([
      { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
    ]);
    const capture = holdProbe(snapshot);
    const screenSize = holdProbe({ width: 390, height: 844 });
    const probe = { android: screenSize, ios: capture }[platform];
    const running = resolveDirectTouchReferenceFrameSafely({
      ref,
      flags: undefined,
      sessionStore: store,
      contextFromFlags,
      captureSnapshotForSession: capture.read,
      observation: { ...clearAndroidObservationFixture, readScreenSize: screenSize.read },
    });
    await probe.started;
    let replacement;
    if (change === 'rebuild') {
      store.update(ref, { appName: 'updated during probe' });
    } else if (change === 'retire-and-republish') {
      store.retire(ref);
      store.publish(ref.address, session);
    } else if (change === 'replace-recording') {
      replacement = makeTestScreenRecordingResource(session);
      store.update(ref, { screenRecording: replacement });
    }
    probe.release();
    const frame = await running;
    const expected =
      change === 'none' || change === 'rebuild'
        ? { referenceWidth: 390, referenceHeight: 844 }
        : undefined;
    expect(frame, change).toEqual(expected);
    expect(resource.handle.inspect().touchReferenceFrame, change).toEqual(expected);
    expect(replacement?.handle.inspect().touchReferenceFrame, change).toBeUndefined();
    expect(probe.read).toHaveBeenCalledOnce();
    expect(capture.read.mock.calls.length + screenSize.read.mock.calls.length).toBe(1);
    if (change === 'rebuild') {
      expect(store.requireCurrent(ref).appName).toBe('updated during probe');
    }
  },
);
