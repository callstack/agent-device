import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { InternalRequestOptions } from '../../client-types.ts';
import { findCommandMetadata } from '../command-metadata.ts';
import { readMetadataCommandFlags } from '../command-flags.ts';

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
