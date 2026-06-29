import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnapshotNode } from '../../../kernel/snapshot.ts';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: vi.fn(async () => ({ text: 'backend-text' })),
  };
});

import { dispatchCommand } from '../../../core/dispatch.ts';
import { readTextForNode } from '../interaction-read.ts';

const mockDispatch = vi.mocked(dispatchCommand);

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
};

describe('readTextForNode', () => {
  beforeEach(() => mockDispatch.mockClear());

  it('returns snapshot text without a backend read for non-editable nodes', async () => {
    const text = await readTextForNode({
      ...baseParams,
      node: node({ type: 'button', label: 'General' }),
    });
    expect(text).toBe('General');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('still re-reads via the backend for editable text inputs (live value may exceed snapshot)', async () => {
    const text = await readTextForNode({
      ...baseParams,
      node: node({ type: 'textfield', value: 'snap' }),
    });
    expect(mockDispatch).toHaveBeenCalledOnce();
    expect(text).toBe('backend-text');
  });

  it('re-reads when the snapshot node has no readable text', async () => {
    await readTextForNode({ ...baseParams, node: node({ type: 'other' }) });
    expect(mockDispatch).toHaveBeenCalledOnce();
  });

  it('returns snapshot text without a backend read when the node has no resolvable center', async () => {
    const text = await readTextForNode({
      ...baseParams,
      node: node({ type: 'button', label: 'General', rect: undefined }),
    });
    expect(text).toBe('General');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('does NOT skip the backend read on non-iOS platforms (value-first read semantics differ)', async () => {
    for (const platform of ['android', 'macos', 'linux'] as const) {
      mockDispatch.mockClear();
      const text = await readTextForNode({
        ...baseParams,
        device: { platform } as never,
        node: node({ type: 'button', label: 'General' }),
      });
      expect(mockDispatch).toHaveBeenCalledOnce();
      expect(text).toBe('backend-text');
    }
  });
});
