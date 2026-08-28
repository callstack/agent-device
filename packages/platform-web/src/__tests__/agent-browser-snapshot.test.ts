import { describe, expect, test } from 'vitest';

import { normalizeAgentBrowserSnapshot } from '../agent-browser-snapshot.ts';

describe('normalizeAgentBrowserSnapshot', () => {
  test('marks nodes disabled from the [disabled] text annotation', async () => {
    const result = await normalizeAgentBrowserSnapshot({
      snapshot: [
        '- generic',
        '  - button "Enabled Button" [ref=e1]',
        '  - button "Disabled Button" [disabled, ref=e2]',
        '  - link "Aria Disabled" [disabled, ref=e3]',
      ].join('\n'),
      refs: {
        e1: { name: 'Enabled Button', role: 'button' },
        e2: { name: 'Disabled Button', role: 'button' },
        e3: { name: 'Aria Disabled', role: 'link' },
      },
    });

    expect(result.nodes.map((node) => node.enabled)).toEqual([undefined, false, false]);
  });

  test('does not read disabled from bracket-like text inside labels', async () => {
    const result = await normalizeAgentBrowserSnapshot({
      snapshot: '  - button "Shows [disabled] in its label" [ref=e1]',
      refs: { e1: { name: 'Shows [disabled] in its label', role: 'button' } },
    });

    expect(result.nodes[0]?.enabled).toBeUndefined();
    expect(result.nodes[0]?.label).toBe('Shows [disabled] in its label');
  });

  test('does not read disabled from a trailing value outside the annotation group', async () => {
    const result = await normalizeAgentBrowserSnapshot({
      snapshot: '  - textbox "Status" [ref=e1]: [disabled, ref=e9]',
      refs: { e1: { name: 'Status', role: 'textbox' } },
    });

    expect(result.nodes[0]?.enabled).toBeUndefined();
    expect(result.nodes[0]?.value).toBe('[disabled, ref=e9]');
  });

  test('does not read disabled from a label that embeds a ref-shaped annotation', async () => {
    const result = await normalizeAgentBrowserSnapshot({
      snapshot: '  - button "Shows [disabled, ref=e1]" [ref=e1]',
      refs: { e1: { name: 'Shows [disabled, ref=e1]', role: 'button' } },
    });

    expect(result.nodes[0]?.enabled).toBeUndefined();
    expect(result.nodes[0]?.label).toBe('Shows [disabled, ref=e1]');
  });

  test('metadata enabled still wins over the text annotation', async () => {
    const result = await normalizeAgentBrowserSnapshot({
      snapshot: '  - button "Odd" [disabled, ref=e1]',
      refs: { e1: { name: 'Odd', role: 'button', enabled: true } },
    });

    expect(result.nodes[0]?.enabled).toBe(true);
  });
});
