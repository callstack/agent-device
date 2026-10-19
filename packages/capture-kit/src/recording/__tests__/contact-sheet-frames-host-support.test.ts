import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { CONTACT_SHEET_UNSUPPORTED_HOST_REASON } from '../contact-sheet-report.ts';
import { assertContactSheetHostSupport } from '../contact-sheet-frames.ts';

test('contact sheets are explicitly unsupported on non-macOS hosts', () => {
  assert.throws(
    () => assertContactSheetHostSupport('linux'),
    (error: unknown) => {
      return (
        error instanceof AppError &&
        error.code === 'UNSUPPORTED_OPERATION' &&
        error.details?.reason === CONTACT_SHEET_UNSUPPORTED_HOST_REASON
      );
    },
  );
  assert.doesNotThrow(() => assertContactSheetHostSupport('darwin'));
});
