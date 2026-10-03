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

  test('preserves the backend ref so the displayed ref is the actionable one', async () => {
    // agent-browser mints refs in tree order and skips non-interactive nodes
    // (the leading `generic` container never gets a ref), so the refs are NOT dense:
    //   e1 = generic  (skipped here, no ref on it)
    //   e2 = username textbox
    //   e3 = passcode textbox   <-- agent presses @e3 expecting username
    //   e4 = sign-in button
    // The username textbox is the 2nd NODE in the snapshot but its backend ref is e2.
    // If agent-device re-mints dense positional refs, the snapshot would show the
    // username as @e2 while the passcode (node 3) shows @e3 — and an agent that
    // reads "@e3 = passcode" would land in the passcode field when it meant the
    // username, because the backend's own e3 resolves to a different element.
    // Preserving the backend ref keeps display ref == actionable ref.
    const result = await normalizeAgentBrowserSnapshot({
      snapshot: [
        '- textbox "Username" [ref=e2]',
        '- textbox "Passcode" [ref=e3]',
        '- button "Sign in" [ref=e4]',
      ].join('\n'),
      refs: {
        e2: { role: 'textbox', name: 'Username' },
        e3: { role: 'textbox', name: 'Passcode' },
        e4: { role: 'button', name: 'Sign in' },
      },
    });

    expect(result.nodes.map((node) => node.label)).toEqual(['Username', 'Passcode', 'Sign in']);
    expect(result.nodes.map((node) => node.ref)).toEqual(['e2', 'e3', 'e4']);
  });
});
