import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { finalizeResumableUpload } from '../resumable-upload.ts';

test('finalizing an unknown upload reports expiry with a recovery hint', async () => {
  const error = await finalizeResumableUpload('missing-upload-id').then(
    () => null,
    (err: unknown) => err,
  );
  assert.equal(error instanceof AppError, true);
  const appError = error as AppError;
  assert.equal(appError.code, 'COMMAND_FAILED');
  assert.equal(appError.message, 'Upload not found or expired: missing-upload-id');
  assert.equal(appError.details?.reason, 'RESOURCE_EXPIRED');
  assert.equal(typeof appError.details?.hint, 'string');
});
