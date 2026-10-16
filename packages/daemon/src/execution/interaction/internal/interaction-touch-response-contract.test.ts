import { expect, test } from 'vitest';
import type { PressCommandResult } from '@agent-device/contracts/interaction';
import { buildInteractionResponseData } from './interaction-touch-response.ts';

test('the response builder keeps capture evidence out of serialized touch payloads', () => {
  const node = { ref: 'e1', index: 0, type: 'Button', label: 'Continue' };
  const result = {
    kind: 'selector',
    point: { x: 100, y: 200 },
    target: { kind: 'selector', selector: 'label=Continue' },
    node,
    selectorChain: ['label=Continue'],
    preAction: { nodes: [node] },
    backendResult: { ref: 'e1' },
    targetEvidence: { id: 'target-evidence-private' },
  } as PressCommandResult & { targetEvidence: { id: string } };

  const payloads = buildInteractionResponseData({
    source: { kind: 'runtime', result },
    referenceFrame: undefined,
  });

  expect(payloads.recordedTarget).toEqual({ node, preActionNodes: [node] });
  for (const payload of [payloads.result, payloads.responseData]) {
    expect(payload).not.toHaveProperty('node');
    expect(payload).not.toHaveProperty('preAction');
    expect(payload).not.toHaveProperty('targetEvidence');
  }
});
