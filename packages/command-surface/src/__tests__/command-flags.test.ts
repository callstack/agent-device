import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { InternalRequestOptions } from '@agent-device/contracts/command';
import { findCommandMetadata } from '../command-metadata.ts';
import { buildRequestFlags, readMetadataCommandFlags } from '../command-flags.ts';

test('readMetadataCommandFlags projects CLI-backed command fields and skips positionals', () => {
  const metadata = findCommandMetadata('scroll');
  assert.ok(metadata);

  const flags = readMetadataCommandFlags(metadata, {
    direction: 'down',
    amount: 0.4,
    pixels: 200,
    durationMs: 50,
  } as InternalRequestOptions);

  assert.deepEqual(flags, {
    pixels: 200,
    durationMs: 50,
  });
});

test.for(['scroll', 'swipe'] as const)(
  '%s sends the stabilization opt-out as the daemon flag, never under the caller key',
  (command) => {
    const metadata = findCommandMetadata(command);
    assert.ok(metadata);
    const options = { noPostGestureStabilization: true } as InternalRequestOptions;

    const metadataFlags = readMetadataCommandFlags(metadata, options);
    const requestFlags = buildRequestFlags(options, metadataFlags);

    assert.deepEqual(metadataFlags, { postGestureStabilization: false });
    assert.equal(requestFlags.postGestureStabilization, false);
    assert.equal(Object.hasOwn(requestFlags, 'noPostGestureStabilization'), false);
  },
);

test.for([{ noPostGestureStabilization: false }, {}] as const)(
  'a request that does not opt out leaves the daemon default alone: %o',
  (input) => {
    const metadata = findCommandMetadata('scroll');
    assert.ok(metadata);
    const options = input as InternalRequestOptions;

    const requestFlags = buildRequestFlags(options, readMetadataCommandFlags(metadata, options));

    // `false` from the caller is not the daemon's `true`, which force-enables stabilization.
    assert.equal(Object.hasOwn(requestFlags, 'postGestureStabilization'), false);
    assert.equal(Object.hasOwn(requestFlags, 'noPostGestureStabilization'), false);
  },
);

test('a command that does not declare the opt-out ignores it', () => {
  const metadata = findCommandMetadata('press');
  assert.ok(metadata);

  const flags = readMetadataCommandFlags(metadata, {
    noPostGestureStabilization: true,
  } as InternalRequestOptions);

  assert.deepEqual(flags, {});
});
