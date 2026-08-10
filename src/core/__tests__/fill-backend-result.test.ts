import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFillBackendResult } from '../fill-backend-result.ts';

test('readFillBackendResult preserves a complete unconfirmed verification', () => {
  assert.deepEqual(
    readFillBackendResult({
      verification: 'unconfirmed',
      requested: '0501234567',
      before: '12 123 4567',
      after: '05 012 3456',
      target: {
        resourceId: 'com.example:id/phone',
        className: 'android.widget.EditText',
        packageName: 'com.example',
        rect: { x: 0, y: 0, width: 200, height: 100 },
      },
    }),
    {
      verification: 'unconfirmed',
      requested: '0501234567',
      before: '12 123 4567',
      after: '05 012 3456',
      target: {
        resourceId: 'com.example:id/phone',
        className: 'android.widget.EditText',
        packageName: 'com.example',
        rect: { x: 0, y: 0, width: 200, height: 100 },
      },
    },
  );
});

test('readFillBackendResult drops incomplete untrusted evidence', () => {
  assert.deepEqual(
    readFillBackendResult({ verification: 'unconfirmed', requested: 'text', target: {} }),
    {},
  );
});
