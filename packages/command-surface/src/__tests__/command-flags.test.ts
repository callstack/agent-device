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
  '%s passes postGestureStabilization through as a plain boolean flag',
  (command) => {
    const metadata = findCommandMetadata(command);
    assert.ok(metadata);
    const options = { postGestureStabilization: false } as InternalRequestOptions;

    const metadataFlags = readMetadataCommandFlags(metadata, options);

    assert.deepEqual(metadataFlags, { postGestureStabilization: false });
    assert.equal(buildRequestFlags(options, metadataFlags).postGestureStabilization, false);
  },
);

test('a request that does not set postGestureStabilization leaves the daemon default alone', () => {
  const metadata = findCommandMetadata('scroll');
  assert.ok(metadata);
  const options = {} as InternalRequestOptions;

  const requestFlags = buildRequestFlags(options, readMetadataCommandFlags(metadata, options));

  assert.equal(Object.hasOwn(requestFlags, 'postGestureStabilization'), false);
});

test('a command that does not declare postGestureStabilization ignores it', () => {
  const metadata = findCommandMetadata('press');
  assert.ok(metadata);

  const flags = readMetadataCommandFlags(metadata, {
    postGestureStabilization: false,
  } as InternalRequestOptions);

  assert.deepEqual(flags, {});
});
