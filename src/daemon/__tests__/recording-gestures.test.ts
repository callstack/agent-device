import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  augmentScrollVisualizationResult,
  recordTouchVisualizationEvent,
} from '../recording-gestures.ts';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSnapshotState } from '../../__tests__/test-utils/snapshot-builders.ts';

function makeSession() {
  return makeIosSession('default', {
    snapshot: makeSnapshotState(
      [
        {
          index: 0,
          type: 'Application',
          rect: { x: 0, y: 0, width: 402, height: 874 },
        },
      ],
      { backend: 'xctest' },
    ),
    recording: {
      platform: 'ios',
      outPath: '/tmp/demo.mp4',
      startedAt: 1_000,
      showTouches: true,
      gestureEvents: [],
      child: { kill: () => {} } as any,
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    },
  });
}

test('scroll records a semantic scroll gesture for visualization telemetry', () => {
  const session = makeSession();
  const result = augmentScrollVisualizationResult(session, 'scroll', ['down'], {
    direction: 'down',
  });

  recordTouchVisualizationEvent(session, 'scroll', ['down'], result, {}, 1_500, 1_920);

  assert.equal(session.recording?.gestureEvents.length, 1);
  const event = session.recording?.gestureEvents[0];
  assert.equal(event?.kind, 'scroll');
  if (!event || event.kind !== 'scroll') return;

  assert.equal(event.tMs, 500);
  assert.equal(event.referenceWidth, 402);
  assert.equal(event.referenceHeight, 874);
  assert.equal(event.x, 201);
  assert.equal(event.y, 699);
  assert.equal(event.x2, 201);
  assert.equal(event.y2, 175);
  assert.equal(event.durationMs, 250);
  assert.equal(event.contentDirection, 'down');
});

test('scroll amount scales swipe travel for visualization', () => {
  const session = makeSession();
  const result = augmentScrollVisualizationResult(session, 'scroll', ['right', '0.6'], {
    direction: 'right',
    amount: 0.6,
  });

  recordTouchVisualizationEvent(session, 'scroll', ['right', '0.6'], result, {}, 1_500);

  const event = session.recording?.gestureEvents[0];
  assert.equal(event?.kind, 'scroll');
  if (!event || event.kind !== 'scroll') return;

  assert.equal(event.x, 322);
  assert.equal(event.x2, 80);
  assert.equal(event.y, 437);
  assert.equal(event.y2, 437);
  assert.equal(event.amount, 0.6);
});

test('scroll augmentation preserves explicit duration for visualization', () => {
  const session = makeSession();
  const result = augmentScrollVisualizationResult(session, 'scroll', ['up', '0.6'], {
    direction: 'up',
    amount: 0.6,
    durationMs: 100,
  });

  recordTouchVisualizationEvent(session, 'scroll', ['up', '0.6'], result, {}, 1_500);

  const event = session.recording?.gestureEvents[0];
  assert.equal(event?.kind, 'scroll');
  assert.equal(event?.durationMs, 100);
});

test('scroll augmentation preserves explicit reference frame from platform result', () => {
  const session = makeSession();
  session.snapshot = undefined;

  const augmented = augmentScrollVisualizationResult(session, 'scroll', ['down', '0.45'], {
    direction: 'down',
    referenceWidth: 402,
    referenceHeight: 874,
  }) as Record<string, unknown>;

  assert.equal(augmented.referenceWidth, 402);
  assert.equal(augmented.referenceHeight, 874);
  assert.equal(augmented.x1, 201);
  assert.equal(augmented.y1, 634);
  assert.equal(augmented.x2, 201);
  assert.equal(augmented.y2, 240);
});

test('scroll visualization preserves absolute travel in its zero-origin reference frame', () => {
  const session = makeSession();
  session.snapshot = undefined;

  const augmented = augmentScrollVisualizationResult(session, 'scroll', ['down'], {
    direction: 'down',
    pixels: 240,
    x1: 211,
    y1: 577,
    x2: 211,
    y2: 337,
    referenceWidth: 412,
    referenceHeight: 894,
  }) as Record<string, unknown>;

  recordTouchVisualizationEvent(session, 'scroll', ['down'], augmented, {}, 1_500);

  assert.equal(augmented.x1, 211);
  assert.equal(augmented.y1, 577);
  assert.equal(augmented.x2, 211);
  assert.equal(augmented.y2, 337);
  assert.equal(augmented.pixels, 240);
  const event = session.recording?.gestureEvents[0];
  assert.equal(event?.kind, 'scroll');
  assert.equal(event?.referenceWidth, 412);
  assert.equal(event?.referenceHeight, 894);
  assert.equal(event?.x, 211);
  assert.equal(event?.y, 577);
  assert.equal(event?.x2, 211);
  assert.equal(event?.y2, 337);
});

test('gesture recording prefers native runner timing when available', () => {
  const session = makeSession();
  session.recording = {
    platform: 'ios-device-runner',
    outPath: '/tmp/demo.mp4',
    remotePath: 'tmp/demo.mp4',
    startedAt: 1_000,
    showTouches: true,
    gestureEvents: [],
    runnerStartedAtUptimeMs: 5_000,
  };

  recordTouchVisualizationEvent(
    session,
    'press',
    ['201', '437'],
    { x: 201, y: 437, gestureStartUptimeMs: 5_180 },
    {},
    9_999,
  );

  const event = session.recording?.gestureEvents[0];
  assert.equal(event?.kind, 'tap');
  assert.equal(event?.tMs, 180);
});

test('ios tap visualization anchors near completion when command execution stalls', () => {
  const session = makeSession();

  recordTouchVisualizationEvent(session, 'click', [], { x: 201, y: 319 }, {}, 1_500, 3_700);

  const event = session.recording?.gestureEvents[0];
  assert.equal(event?.kind, 'tap');
  assert.equal(event?.tMs, 2_440);
});

test('swipe visualization prefers native gesture duration when available', () => {
  const session = makeSession();

  recordTouchVisualizationEvent(
    session,
    'swipe',
    ['10', '20', '110', '220', '300'],
    {
      x1: 10,
      y1: 20,
      x2: 110,
      y2: 220,
      durationMs: 300,
      gestureStartUptimeMs: 5_000,
      gestureEndUptimeMs: 5_780,
    },
    {},
    2_000,
    2_300,
  );

  const event = session.recording?.gestureEvents[0];
  assert.equal(event?.kind, 'swipe');
  if (!event || event.kind !== 'swipe') return;

  assert.equal(event.durationMs, 780);
});

test('canonical gesture results record pan, fling, and pinch visualization telemetry', () => {
  const session = makeSession();

  recordTouchVisualizationEvent(
    session,
    'gesture',
    ['pan', '40', '100', '120', '-20', '360'],
    {
      kind: 'pan',
      from: { x: 40, y: 100 },
      to: { x: 160, y: 80 },
      durationMs: 360,
      pointerCount: 1,
    },
    {},
    1_500,
    1_860,
  );
  recordTouchVisualizationEvent(
    session,
    'gesture',
    ['fling', 'left', '260', '400', '180'],
    {
      kind: 'fling',
      from: { x: 260, y: 400 },
      to: { x: 80, y: 400 },
      durationMs: 180,
      pointerCount: 1,
    },
    {},
    1_900,
    2_080,
  );
  recordTouchVisualizationEvent(
    session,
    'gesture',
    ['pinch', '1.5', '201', '437'],
    {
      kind: 'pinch',
      from: { x: 201, y: 437 },
      to: { x: 201, y: 437 },
      scale: 1.5,
      durationMs: 280,
      pointerCount: 2,
    },
    {},
    2_100,
    2_380,
  );

  assert.deepEqual(session.recording?.gestureEvents, [
    {
      kind: 'swipe',
      tMs: 500,
      x: 40,
      y: 100,
      x2: 160,
      y2: 80,
      referenceWidth: 402,
      referenceHeight: 874,
      durationMs: 360,
    },
    {
      kind: 'swipe',
      tMs: 900,
      x: 260,
      y: 400,
      x2: 80,
      y2: 400,
      referenceWidth: 402,
      referenceHeight: 874,
      durationMs: 180,
    },
    {
      kind: 'pinch',
      tMs: 1_100,
      x: 201,
      y: 437,
      referenceWidth: 402,
      referenceHeight: 874,
      scale: 1.5,
      durationMs: 280,
    },
  ]);
});

test('canonical rotate records centroid visualization telemetry', () => {
  const session = makeSession();

  recordTouchVisualizationEvent(
    session,
    'gesture',
    ['rotate', '35', '201', '437'],
    {
      kind: 'rotate',
      from: { x: 201, y: 437 },
      to: { x: 201, y: 437 },
      durationMs: 300,
      pointerCount: 2,
    },
    {},
    1_500,
    1_800,
  );

  assert.deepEqual(session.recording?.gestureEvents, [
    {
      kind: 'swipe',
      tMs: 500,
      x: 201,
      y: 437,
      x2: 201,
      y2: 437,
      referenceWidth: 402,
      referenceHeight: 874,
      durationMs: 300,
    },
  ]);
});

test('canonical multi-touch travel does not acquire one-finger back-swipe semantics', () => {
  const session = makeSession();

  recordTouchVisualizationEvent(
    session,
    'gesture',
    ['transform', '10', '437', '170', '0', '1.4', '25', '600'],
    {
      kind: 'transform',
      from: { x: 10, y: 437 },
      to: { x: 180, y: 437 },
      durationMs: 600,
      pointerCount: 2,
    },
    {},
    1_500,
    2_100,
  );
  recordTouchVisualizationEvent(
    session,
    'gesture',
    ['pan', '392', '437', '-170', '0', '400'],
    {
      kind: 'pan',
      from: { x: 392, y: 437 },
      to: { x: 222, y: 437 },
      durationMs: 400,
      pointerCount: 2,
    },
    {},
    2_200,
    2_600,
  );

  assert.deepEqual(session.recording?.gestureEvents, [
    {
      kind: 'swipe',
      tMs: 500,
      x: 10,
      y: 437,
      x2: 180,
      y2: 437,
      referenceWidth: 402,
      referenceHeight: 874,
      durationMs: 600,
    },
    {
      kind: 'swipe',
      tMs: 1_200,
      x: 392,
      y: 437,
      x2: 222,
      y2: 437,
      referenceWidth: 402,
      referenceHeight: 874,
      durationMs: 400,
    },
  ]);
});

test('telemetry is still captured when touch overlays are hidden', () => {
  const session = makeSession();
  if (session.recording) {
    session.recording.showTouches = false;
  }

  recordTouchVisualizationEvent(session, 'press', ['100', '200'], { x: 100, y: 200 }, {}, 1_500);

  assert.equal(session.recording?.gestureEvents.length, 1);
  assert.equal(session.recording?.gestureEvents[0]?.kind, 'tap');
});

test('explicit event reference frame overrides stale snapshot geometry', () => {
  const session = makeSession();

  recordTouchVisualizationEvent(
    session,
    'press',
    ['300', '2300'],
    {
      x: 300,
      y: 2300,
      referenceWidth: 1344,
      referenceHeight: 2992,
    },
    {},
    1_500,
  );

  const event = session.recording?.gestureEvents[0];
  assert.equal(event?.kind, 'tap');
  assert.equal(event?.referenceWidth, 1344);
  assert.equal(event?.referenceHeight, 2992);
});

test('edge swipe is classified as a back-swipe telemetry event', () => {
  const session = makeSession();

  recordTouchVisualizationEvent(
    session,
    'swipe',
    ['10', '400', '180', '400', '320'],
    { x1: 10, y1: 400, x2: 180, y2: 400, durationMs: 320 },
    {},
    1_500,
    1_900,
  );

  const event = session.recording?.gestureEvents[0];
  assert.equal(event?.kind, 'back-swipe');
  if (!event || event.kind !== 'back-swipe') return;

  assert.equal(event.edge, 'left');
  assert.equal(event.durationMs, 320);
});
