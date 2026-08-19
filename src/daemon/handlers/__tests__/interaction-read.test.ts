import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { ReadTextAtPointInput } from '@agent-device/contracts/platform';
import { readTextForNode } from '../interaction-read.ts';

/**
 * Bound at the seam the handler consumes (the runtime's `readTextAtPoint` operation), never at
 * `core/dispatch.ts`: `get` is migrated, so the live read reaches this fake through the request
 * binding rather than through the legacy dispatcher.
 */
const readTextAtPoint = vi.fn(async (_input: ReadTextAtPointInput) => 'backend-text');

function node(overrides: Partial<SnapshotNode>): SnapshotNode {
  return {
    ref: 'e1',
    index: 0,
    rect: { x: 0, y: 0, width: 100, height: 40 },
    ...overrides,
  } as SnapshotNode;
}

const baseParams = {
  device: { platform: 'ios' } as never,
  flags: undefined,
  contextFromFlags: () => ({}) as never,
  readTextAtPoint,
};

describe('readTextForNode', () => {
  beforeEach(() => readTextAtPoint.mockClear());

  it('returns snapshot text without a live read for non-editable nodes', async () => {
    const text = await readTextForNode({
      ...baseParams,
      node: node({ type: 'button', label: 'General' }),
    });
    expect(text).toBe('General');
    expect(readTextAtPoint).not.toHaveBeenCalled();
  });

  it('still re-reads live for editable text inputs (live value may exceed snapshot)', async () => {
    const text = await readTextForNode({
      ...baseParams,
      node: node({ type: 'textfield', value: 'snap' }),
    });
    expect(readTextAtPoint).toHaveBeenCalledOnce();
    expect(text).toBe('backend-text');
  });

  it('reads at the resolved node center', async () => {
    await readTextForNode({ ...baseParams, node: node({ type: 'textfield', value: 'snap' }) });
    expect(readTextAtPoint.mock.calls[0]?.[0].point).toEqual({ x: 50, y: 20 });
  });

  it('re-reads when the snapshot node has no readable text', async () => {
    await readTextForNode({ ...baseParams, node: node({ type: 'other' }) });
    expect(readTextAtPoint).toHaveBeenCalledOnce();
  });

  it('returns snapshot text without a live read when the node has no resolvable center', async () => {
    const text = await readTextForNode({
      ...baseParams,
      node: node({ type: 'button', label: 'General', rect: undefined }),
    });
    expect(text).toBe('General');
    expect(readTextAtPoint).not.toHaveBeenCalled();
  });

  it('does NOT skip the live read on non-iOS platforms (value-first read semantics differ)', async () => {
    for (const platform of ['android', 'macos', 'linux'] as const) {
      readTextAtPoint.mockClear();
      const text = await readTextForNode({
        ...baseParams,
        device: { platform } as never,
        node: node({ type: 'button', label: 'General' }),
      });
      expect(readTextAtPoint).toHaveBeenCalledOnce();
      expect(text).toBe('backend-text');
    }
  });

  // The preferred-operation absence row: an owner whose facts advertise no live read answers
  // entirely from the captured tree. That is the complete required path, not a fallback.
  it('answers from the captured tree when the bound owner exposes no live read', async () => {
    const text = await readTextForNode({
      ...baseParams,
      readTextAtPoint: undefined,
      node: node({ type: 'textfield', value: 'snap' }),
    });
    expect(text).toBe('snap');
    expect(readTextAtPoint).not.toHaveBeenCalled();
  });

  it('falls back to the captured tree through a typed reason when the live read fails', async () => {
    readTextAtPoint.mockRejectedValueOnce(new Error('runner transport closed'));
    const text = await readTextForNode({
      ...baseParams,
      node: node({ type: 'textfield', value: 'snap' }),
    });
    expect(text).toBe('snap');
  });

  it('falls back to the captured tree when the live read returns blank text', async () => {
    readTextAtPoint.mockResolvedValueOnce('   ');
    const text = await readTextForNode({
      ...baseParams,
      node: node({ type: 'textfield', value: 'snap' }),
    });
    expect(text).toBe('snap');
  });
});
