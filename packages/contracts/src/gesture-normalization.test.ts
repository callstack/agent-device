import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  describeReplayGestureArityError,
  gesturePayloadFromPositionals,
  gesturePayloadToPositionals,
  normalizeGestureCommandInput,
  normalizePublicGesture,
  normalizePublicSwipeMotion,
  swipePayloadFromPositionals,
} from './gesture-normalization.ts';

test('CLI and .ad positionals normalize at one explicit syntax seam', () => {
  assert.deepEqual(gesturePayloadFromPositionals(['pan', '10', '20', '30', '-40', '500'], 2), {
    kind: 'pan',
    origin: { x: 10, y: 20 },
    delta: { x: 30, y: -40 },
    durationMs: 500,
    pointerCount: 2,
  });
});

test('CLI and .ad coordinate swipes normalize at one explicit syntax seam', () => {
  assert.deepEqual(
    swipePayloadFromPositionals(['10', '20', '30', '40'], {
      count: 2,
      pauseMs: 5,
      pattern: 'ping-pong',
    }),
    {
      from: { x: 10, y: 20 },
      to: { x: 30, y: 40 },
      count: 2,
      pauseMs: 5,
      pattern: 'ping-pong',
    },
  );
});

test('gesture recording codec round-trips structured requests', () => {
  const payload = {
    kind: 'transform' as const,
    origin: { x: 10, y: 20 },
    delta: { x: 30, y: -40 },
    scale: 1.5,
    degrees: -35,
    durationMs: 600,
  };
  assert.deepEqual(gesturePayloadFromPositionals(gesturePayloadToPositionals(payload)), payload);
});

test('gesture recording codec round-trips fling with distance', () => {
  const payload = {
    kind: 'fling' as const,
    direction: 'left' as const,
    origin: { x: 10, y: 20 },
    distance: 180,
  };
  assert.deepEqual(gesturePayloadFromPositionals(gesturePayloadToPositionals(payload)), payload);
});

test('gesture recording codec round-trips selector-authored drag timings', () => {
  const payload = {
    kind: 'drag' as const,
    source: 'id="drag-source"',
    destination: '@e2~s42',
    sourceHoldMs: 800,
    moveMs: 700,
    destinationHoldMs: 250,
  };
  assert.deepEqual(gesturePayloadFromPositionals(gesturePayloadToPositionals(payload)), payload);
});

test('drag recording materializes all timing slots for every sparse option combination', () => {
  for (let mask = 0; mask < 8; mask += 1) {
    const payload = {
      kind: 'drag' as const,
      source: 'id="source"',
      destination: 'id="destination"',
      ...(mask & 1 ? { sourceHoldMs: 900 } : {}),
      ...(mask & 2 ? { moveMs: 700 } : {}),
      ...(mask & 4 ? { destinationHoldMs: 200 } : {}),
    };
    assert.deepEqual(gesturePayloadFromPositionals(gesturePayloadToPositionals(payload)), {
      ...payload,
      sourceHoldMs: payload.sourceHoldMs ?? 800,
      moveMs: payload.moveMs ?? 500,
      destinationHoldMs: payload.destinationHoldMs ?? 0,
    });
  }
});

test('drag payloads normalize to one target-authored runtime command', () => {
  assert.deepEqual(
    normalizeGestureCommandInput({
      kind: 'drag',
      source: 'id="drag-source"',
      destination: 'id="drop-target"',
      sourceHoldMs: 700,
      moveMs: 450,
      destinationHoldMs: 100,
    }),
    {
      intent: 'drag',
      source: 'id="drag-source"',
      destination: 'id="drop-target"',
      sourceHoldMs: 700,
      moveMs: 450,
      destinationHoldMs: 100,
    },
  );
});

test('gesture drag positional syntax requires both endpoints and rejects trailing arguments', () => {
  assert.throws(() => gesturePayloadFromPositionals(['drag', 'id="drag-source"']), {
    code: 'INVALID_ARGS',
  });
  assert.throws(
    () =>
      gesturePayloadFromPositionals([
        'drag',
        'id="drag-source"',
        'id="drop-target"',
        '800',
        '500',
        '0',
        'extra',
      ]),
    {
      code: 'INVALID_ARGS',
      message:
        'gesture drag accepts at most 5 arguments: source destination [sourceHoldMs] [moveMs] [destinationHoldMs].',
    },
  );
});

test('a retired trailing positional reports its migration, not a bare usage line', () => {
  assert.throws(() => swipePayloadFromPositionals(['197', '650', '197', '300', '300']), {
    code: 'INVALID_ARGS',
    message:
      'swipe accepts 4 arguments: x1 y1 x2 y2. The trailing durationMs positional was removed: use "gesture pan 197 650 0 -350 300" for the same timed drag, or "swipe 197 650 197 300" for a default-duration swipe.',
  });
  assert.throws(() => gesturePayloadFromPositionals(['fling', 'down', '100', '200', '80', '500']), {
    code: 'INVALID_ARGS',
    message: /trailing durationMs positional was removed: use "gesture fling down 100 200 80"/,
  });
  assert.throws(() => gesturePayloadFromPositionals(['swipe', 'left', '500']), {
    code: 'INVALID_ARGS',
    message: /trailing durationMs positional was removed: use "gesture swipe left"/,
  });
  assert.throws(() => gesturePayloadFromPositionals(['rotate', '35', '100', '200', '800']), {
    code: 'INVALID_ARGS',
    message: /trailing velocity positional was removed: use "gesture rotate 35 100 200"/,
  });
});

test('a malformed line is a usage error rather than a migration claim', () => {
  assert.throws(() => swipePayloadFromPositionals(['1', '2', '3', '4', '5', '6']), {
    code: 'INVALID_ARGS',
    message: 'swipe accepts 4 arguments: x1 y1 x2 y2.',
  });
  assert.throws(() => swipePayloadFromPositionals(['1', '2', '3', '4', '--unknown']), {
    code: 'INVALID_ARGS',
    message: 'swipe accepts 4 arguments: x1 y1 x2 y2.',
  });
  assert.throws(() => swipePayloadFromPositionals(['1', '2', '3', '4', 'hello']), {
    code: 'INVALID_ARGS',
    message: 'swipe accepts 4 arguments: x1 y1 x2 y2.',
  });
});

test('the .ad preflight names the offending line and leaves live syntax alone', () => {
  assert.equal(
    describeReplayGestureArityError('swipe', ['197', '650', '197', '300', '300'], 'line 6'),
    'swipe accepts 4 arguments: x1 y1 x2 y2 (line 6). The trailing durationMs positional was removed: use "gesture pan 197 650 0 -350 300" for the same timed drag, or "swipe 197 650 197 300" for a default-duration swipe.',
  );
  assert.equal(
    describeReplayGestureArityError('gesture', ['pan', '110', '443', '48', '0', '500'], 'line 2'),
    undefined,
  );
  assert.equal(describeReplayGestureArityError('click', ['120', '240'], 'line 2'), undefined);
});

test('a variable-backed retired positional still gets the migration', () => {
  assert.equal(
    describeReplayGestureArityError('swipe', ['197', '650', '197', '300', '${DURATION}'], 'line 6'),
    'swipe accepts 4 arguments: x1 y1 x2 y2 (line 6). The trailing durationMs positional was removed: use "gesture pan 197 650 0 -350 ${DURATION}" for the same timed drag, or "swipe 197 650 197 300" for a default-duration swipe.',
  );
  assert.equal(
    describeReplayGestureArityError(
      'swipe',
      ['${X1}', '${Y1}', '${X2}', '${Y2}', '${DURATION}'],
      'line 6',
    ),
    'swipe accepts 4 arguments: x1 y1 x2 y2 (line 6). The trailing durationMs positional was removed: use "gesture pan x1 y1 dx dy durationMs" for the same timed drag, or "swipe ${X1} ${Y1} ${X2} ${Y2}" for a default-duration swipe.',
  );
  assert.match(
    describeReplayGestureArityError('gesture', ['rotate', '35', '195', '443', '${V}'], 'line 4') ??
      '',
    /trailing velocity positional was removed: use "gesture rotate 35 195 443"/,
  );
});

test('the .ad preflight defers to dispatch for values it cannot know yet', () => {
  // `${VAR}` tokens resolve after planning, and interpolation never splits a
  // token, so only the argument count is decidable at parse time.
  assert.equal(
    describeReplayGestureArityError('swipe', ['${X1}', '${Y1}', '${X2}', '${Y2}'], 'line 3'),
    undefined,
  );
  assert.equal(
    describeReplayGestureArityError('gesture', ['${KIND}', '1', '2', '3'], 'line 4'),
    undefined,
  );
});

test('pinch and rotate syntax rejects a partial origin', () => {
  assert.throws(() => gesturePayloadFromPositionals(['pinch', '1.5', '100']), {
    code: 'INVALID_ARGS',
  });
  assert.throws(() => gesturePayloadFromPositionals(['rotate', '35', '100']), {
    code: 'INVALID_ARGS',
  });
});

test('swipe is fling sugar', () => {
  assert.deepEqual(normalizePublicGesture({ kind: 'swipe', preset: 'left' }), {
    gesture: { intent: 'fling', preset: 'left' },
  });
});

test('coordinate swipe is a quick fling', () => {
  assert.deepEqual(
    normalizePublicSwipeMotion({
      from: { x: 360, y: 400 },
      to: { x: 40, y: 400 },
    }),
    {
      gesture: { intent: 'fling', from: { x: 360, y: 400 }, to: { x: 40, y: 400 } },
    },
  );
});

test('fling stays a fling', () => {
  assert.deepEqual(
    normalizePublicGesture({
      kind: 'fling',
      direction: 'left',
      origin: { x: 200, y: 300 },
      distance: 80,
    }),
    {
      gesture: {
        intent: 'fling',
        direction: 'left',
        origin: { x: 200, y: 300 },
        distance: 80,
      },
    },
  );
});

test('multi-touch aliases become constraints on transform motion', () => {
  assert.deepEqual(normalizePublicGesture({ kind: 'pinch', scale: 1.5 }).gesture, {
    intent: 'pinch',
    origin: undefined,
    scale: 1.5,
  });
  assert.deepEqual(normalizePublicGesture({ kind: 'rotate', degrees: -45 }), {
    gesture: { intent: 'rotate', origin: undefined, degrees: -45 },
  });
});
