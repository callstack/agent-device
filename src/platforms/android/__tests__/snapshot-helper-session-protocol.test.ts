import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  assertAndroidSnapshotHelperTouchSessionHeaders,
  isAndroidSnapshotHelperSessionCommandAcknowledged,
  parseAndroidSnapshotHelperSessionHeaders,
  parseAndroidSnapshotHelperSessionSnapshotResponse,
} from '../snapshot-helper-session-protocol.ts';

test('parses the session envelope and snapshot metadata', () => {
  const xml = '<hierarchy><node text="catalog" /></hierarchy>';
  const response = sessionResponse({
    requestId: 'snapshot-1',
    xml,
    metadata: {
      captureMode: 'interactive-windows',
      windowCount: '2',
      nodeCount: '1',
    },
  });

  assert.deepEqual(parseAndroidSnapshotHelperSessionSnapshotResponse(response, 'snapshot-1'), {
    xml,
    metadata: {
      helperApiVersion: '1',
      outputFormat: 'uiautomator-xml',
      captureMode: 'interactive-windows',
      windowCount: 2,
      nodeCount: 1,
      waitForIdleTimeoutMs: undefined,
      waitForIdleQuietMs: undefined,
      timeoutMs: undefined,
      maxDepth: undefined,
      maxNodes: undefined,
      rootPresent: undefined,
      truncated: undefined,
      elapsedMs: undefined,
    },
  });
});

test('rejects stale and truncated session snapshot responses', () => {
  const response = sessionResponse({
    requestId: 'snapshot-old',
    xml: '<hierarchy></hierarchy>',
  });
  assert.throws(
    () => parseAndroidSnapshotHelperSessionSnapshotResponse(response, 'snapshot-new'),
    /stale output/,
  );
  assert.throws(
    () =>
      parseAndroidSnapshotHelperSessionSnapshotResponse(
        response.replace('byteLength=23', 'byteLength=99'),
        'snapshot-old',
      ),
    /truncated XML/,
  );
});

test('validates touch and quit response identity from the same protocol headers', () => {
  const response = sessionResponse({ requestId: 'gesture-1', xml: '' });
  const headers = parseAndroidSnapshotHelperSessionHeaders(response);

  assertAndroidSnapshotHelperTouchSessionHeaders(headers, 'gesture-1');
  assert.equal(isAndroidSnapshotHelperSessionCommandAcknowledged(response, 'gesture-1'), true);
  assert.throws(
    () => assertAndroidSnapshotHelperTouchSessionHeaders(headers, 'gesture-stale'),
    /stale output/,
  );
});

function sessionResponse(params: {
  requestId: string;
  xml: string;
  metadata?: Record<string, string>;
}): string {
  const headers = {
    agentDeviceProtocol: 'android-snapshot-helper-v1',
    helperApiVersion: '1',
    outputFormat: 'uiautomator-xml',
    requestId: params.requestId,
    ok: 'true',
    byteLength: String(Buffer.byteLength(params.xml, 'utf8')),
    ...params.metadata,
  };
  return `${Object.entries(headers)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n\n${params.xml}`;
}
