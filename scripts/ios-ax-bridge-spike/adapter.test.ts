import assert from 'node:assert/strict';
import { test } from 'vitest';
import { defaultPublicMacOsAxHelperPath, readControlSnapshot } from './adapter.ts';

test('public AX adapter resolves the SwiftPM release product', () => {
  assert.equal(
    defaultPublicMacOsAxHelperPath('/repo'),
    '/repo/apple/macos-helper/.build/release/agent-device-ios-ax-bridge-spike',
  );
});

test('control mapping preserves the producer raw node type', () => {
  const result = readControlSnapshot({
    data: {
      results: [
        {
          data: {
            snapshot: {
              nodes: [
                {
                  index: 7,
                  type: 'XCUIElementTypeButton',
                  role: 'AXButton',
                },
              ],
            },
          },
        },
      ],
    },
  });

  assert.equal(result?.nodes[0]?.type, 'XCUIElementTypeButton');
  assert.equal(result?.nodes[0]?.role, 'AXButton');
});
