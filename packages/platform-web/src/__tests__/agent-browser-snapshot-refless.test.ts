import { describe, expect, test } from 'vitest';

import { normalizeAgentBrowserSnapshot } from '../agent-browser-snapshot.ts';

/**
 * Payloads captured from agent-browser against a real page (re-checked on 0.39.0) (`snapshot` with no `--compact`,
 * which is what the capture now asks for), so the projection is tested against the wording the
 * backend actually produces rather than a hand-written approximation of it.
 */
const FORM_AFTER_SUBMIT = {
  snapshot: [
    '- heading "Bench form" [level=1, ref=e1]',
    '- form',
    '  - LabelText',
    '    - StaticText "Name"',
    '  - textbox "Name" [ref=e2]: Zed',
    '    - StaticText "Zed"',
    '  - LabelText',
    '    - StaticText "Email"',
    '  - textbox "Email" [ref=e3]',
    '  - checkbox "I agree" [checked=false, ref=e4]',
    '  - combobox "Color" [expanded=false, ref=e5]: Red',
    '    - MenuListPopup',
    '      - option "Red" [selected, ref=e7]',
    '      - option "Blue" [ref=e8]',
    '  - button "Submit" [ref=e6]',
    '- status',
    '  - StaticText "Hello Zed"',
    '- list',
  ].join('\n'),
  refs: {
    e1: { name: 'Bench form', role: 'heading' },
    e2: { name: 'Name', role: 'textbox' },
    e3: { name: 'Email', role: 'textbox' },
    e4: { name: 'I agree', role: 'checkbox' },
    e5: { name: 'Color', role: 'combobox' },
    e6: { name: 'Submit', role: 'button' },
    e7: { name: 'Red', role: 'option' },
    e8: { name: 'Blue', role: 'option' },
  },
};

/** The same page before the submit announced anything: the `status` region is there and silent. */
const FORM_BEFORE_SUBMIT = {
  snapshot: [
    '- heading "Bench form" [level=1, ref=e1]',
    '- form',
    '  - LabelText',
    '    - StaticText "Name"',
    '  - textbox "Name" [ref=e2]',
    '  - button "Submit" [ref=e6]',
    '- status',
    '- list',
  ].join('\n'),
  refs: {
    e1: { name: 'Bench form', role: 'heading' },
    e2: { name: 'Name', role: 'textbox' },
    e6: { name: 'Submit', role: 'button' },
  },
};

const ROLE_VOCABULARY = {
  snapshot: [
    '- heading "Roles probe" [level=1, ref=e1]',
    '- paragraph',
    '  - StaticText "Paragraph text"',
    '- StaticText "Span text"',
    '- status',
    '  - StaticText "Status text"',
    '- alert',
    '  - StaticText "Alert text"',
    '- note',
    '  - StaticText "Note text"',
    '- LabelText',
    '  - StaticText "Label text"',
    '- textbox "Label text" [ref=e2]',
    '- button "Go" [ref=e3]',
  ].join('\n'),
  refs: {
    e1: { name: 'Roles probe', role: 'heading' },
    e2: { name: 'Label text', role: 'textbox' },
    e3: { name: 'Go', role: 'button' },
  },
};

/** One list item per row, each carrying the bullet the renderer draws. */
const LIST_WITH_MARKERS = {
  snapshot: [
    '- heading "Items" [level=1, ref=e1]',
    '- list',
    '  - listitem',
    '    - ListMarker "• "',
    '    - StaticText "First"',
    '  - listitem',
    '    - ListMarker "• "',
    '    - StaticText "Second"',
  ].join('\n'),
  refs: { e1: { name: 'Items', role: 'heading' } },
};

function refLessNodes(result: Awaited<ReturnType<typeof normalizeAgentBrowserSnapshot>>) {
  return result.nodes.filter((node) => node.ref === undefined);
}

describe('normalizeAgentBrowserSnapshot ref-less content', () => {
  test('publishes the text of a region the backend issued no ref for', async () => {
    const result = await normalizeAgentBrowserSnapshot(FORM_AFTER_SUBMIT);
    const announcement = refLessNodes(result).filter((node) => node.value === 'Hello Zed');

    // The announcement is the reason the capture is taken, and the backend has no ref for it: before,
    // it reached no reader at all, because the backend's `--compact` removed the region with it.
    expect(announcement.length).toBe(1);
    expect(announcement[0]?.type).toBe('StaticText');
    expect(announcement[0]?.ref).toBeUndefined();
    expect(announcement[0]?.label).toBeUndefined();
  });

  test('leaves the ref each control carries untouched', async () => {
    const result = await normalizeAgentBrowserSnapshot(FORM_AFTER_SUBMIT);

    expect(
      result.nodes
        .filter((node) => node.ref !== undefined)
        .map((node) => `${node.type} ${node.ref} ${node.label}`),
    ).toEqual([
      'heading e1 Bench form',
      'textbox e2 Name',
      'textbox e3 Email',
      'checkbox e4 I agree',
      'combobox e5 Color',
      'option e7 Red',
      'option e8 Blue',
      'button e6 Submit',
    ]);
  });

  test('subsumes a label element text under the control that carries it as its name', async () => {
    // The backend prints the same visible string twice: as the `<label>` element's text and as the
    // accessible name of the control it labels. Two nodes reporting `Name` would make the ordinary
    // `text="Name"` on a form refuse as ambiguous, so the string stays on the node an action can
    // address — which is also the answer to "where is this text".
    const result = await normalizeAgentBrowserSnapshot(FORM_AFTER_SUBMIT);
    const refLess = refLessNodes(result).map((node) => node.value);

    expect(refLess).toEqual(['Hello Zed']);
    expect(result.nodes.find((node) => node.ref === 'e2')).toMatchObject({
      label: 'Name',
      value: 'Zed',
    });
  });

  test('carries the text on value, never label', async () => {
    const result = await normalizeAgentBrowserSnapshot(ROLE_VOCABULARY);

    // `label` is the accessible name a selector resolves to an addressable control; a second node
    // claiming it would refuse every `label="Go"` read as ambiguous.
    expect(refLessNodes(result).every((node) => node.label === undefined)).toBe(true);
    expect(
      result.nodes.filter((node) => node.label === 'Label text').map((node) => node.ref),
    ).toEqual(['e2']);
  });

  test('keeps the text of every non-empty region the tree reports', async () => {
    const result = await normalizeAgentBrowserSnapshot(ROLE_VOCABULARY);

    expect(refLessNodes(result).map((node) => `${node.type}=${node.value}`)).toEqual([
      'StaticText=Paragraph text',
      'StaticText=Span text',
      'StaticText=Status text',
      'StaticText=Alert text',
      'StaticText=Note text',
    ]);
  });

  test('drops the empty structural containers compact used to hide', async () => {
    const result = await normalizeAgentBrowserSnapshot(FORM_BEFORE_SUBMIT);
    const types = result.nodes.map((node) => node.type);

    // `form`, `list` and the silent `status` region say nothing the rest of the tree does not say.
    expect(types).not.toContain('form');
    expect(types).not.toContain('list');
    expect(types).not.toContain('status');
    expect(refLessNodes(result)).toEqual([]);
    expect(result.nodes.map((node) => node.ref)).toEqual(['e1', 'e2', 'e6']);
  });

  test('drops the list marker and keeps the text of the item it marks', async () => {
    const result = await normalizeAgentBrowserSnapshot(LIST_WITH_MARKERS);

    expect(result.nodes.map((node) => `${node.type}=${node.value ?? node.label}`)).toEqual([
      'heading=Items',
      'StaticText=First',
      'StaticText=Second',
    ]);
  });

  test('re-parents the children of a dropped container to its parent', async () => {
    // `list` is dropped and `listitem` with it, so each item's text attaches under the root rather
    // than under whichever node happened to be kept last before it.
    const result = await normalizeAgentBrowserSnapshot(LIST_WITH_MARKERS);
    const byValue = new Map(result.nodes.map((node) => [node.value ?? node.label, node]));

    expect(byValue.get('First')?.parentIndex).toBeUndefined();
    expect(byValue.get('Second')?.parentIndex).toBeUndefined();
    expect(byValue.get('Items')?.parentIndex).toBeUndefined();
  });

  test('keeps page text that only coincidentally repeats a control name elsewhere', async () => {
    // Suppression is a structural relation (see `isTextAlreadyReported`), not a page-global
    // denylist: this announcement repeats the SUBMIT button's label and is still the reason a reader
    // opened the page. A table cell echoing a field's contents survives for the same reason. A
    // page-global "drop what any control reports" rule is the mutation this test fails on.
    const result = await normalizeAgentBrowserSnapshot({
      snapshot: [
        '- form',
        '  - button "Submitting" [ref=e1]',
        '- status',
        '  - StaticText "Submitting"',
        '- table',
        '  - row',
        '    - cell',
        '      - StaticText "Zed"',
      ].join('\n'),
      refs: { e1: { name: 'Submitting', role: 'button' }, e2: { name: 'Zed', role: 'textbox' } },
    });

    expect(refLessNodes(result).map((node) => node.value)).toEqual(['Submitting', 'Zed']);
  });

  test('subsumes a control name printed as its own text line inside the control', async () => {
    // The backend spells a control's own string twice — as its name and as a text line under it —
    // and only the descendant shape is a duplicate of that control.
    const result = await normalizeAgentBrowserSnapshot({
      snapshot: ['- button "Go" [ref=e1]', '  - StaticText "Go"', '- StaticText "Go"'].join('\n'),
      refs: { e1: { name: 'Go', role: 'button' } },
    });

    expect(refLessNodes(result).map((node) => node.value)).toEqual(['Go']);
  });

  test('unescapes the quoted name a line carries', async () => {
    const result = await normalizeAgentBrowserSnapshot({
      snapshot: [
        String.raw`- button "He said \"hello\"" [ref=e1]`,
        String.raw`  - StaticText "He said \"hello\""`,
      ].join('\n'),
      refs: { e1: { name: 'He said "hello"', role: 'button' } },
    });

    // Stopping at the escaped quote would report `He said \` as the button's name and leave its own
    // text line looking like different content.
    expect(result.nodes.find((node) => node.ref === 'e1')?.label).toBe('He said "hello"');
    expect(refLessNodes(result)).toEqual([]);
  });

  test('matches a value across the two spellings the backend prints for one string', async () => {
    // agent-browser prints a control's value two ways (both captured live): the trailing `: value`
    // form carries it RAW and a quoted payload carries it ESCAPED. Those are the same string, and
    // the projection must read them that way — unescaping the trailing form as well would turn a
    // value that legitimately contains a backslash into a different string.
    const result = await normalizeAgentBrowserSnapshot({
      snapshot: [
        '- textbox "Name" [ref=e2]: He said "hi"',
        String.raw`  - StaticText "He said \"hi\""`,
      ].join('\n'),
      refs: { e2: { name: 'Name', role: 'textbox' } },
    });

    expect(result.nodes.find((node) => node.ref === 'e2')?.value).toBe('He said "hi"');
    expect(refLessNodes(result)).toEqual([]);
  });

  test('preserves a backslash in a value the backend printed raw', async () => {
    const result = await normalizeAgentBrowserSnapshot({
      snapshot: [String.raw`- textbox "Name" [ref=e2]: a\"b`].join('\n'),
      refs: { e2: { name: 'Name', role: 'textbox' } },
    });

    // The page really holds `a\"b` (verified through the backend against a live input), and the
    // trailing form is not an escaped payload, so the two characters stay.
    expect(result.nodes.find((node) => node.ref === 'e2')?.value).toBe(String.raw`a\"b`);
  });

  test('attaches geometry only to the nodes the backend can measure', async () => {
    const result = await normalizeAgentBrowserSnapshot(
      FORM_AFTER_SUBMIT,
      async (refs) =>
        new Map(
          refs.flatMap((ref) =>
            ref === 'e2' ? [[ref, { x: 1, y: 2, width: 10, height: 20 }] as const] : [],
          ),
        ),
    );

    expect(result.nodes.find((node) => node.ref === 'e2')?.rect).toEqual({
      x: 1,
      y: 2,
      width: 10,
      height: 20,
    });
    expect(refLessNodes(result).every((node) => !node.rect)).toBe(true);
  });

  test('reads no ref from text that merely mentions a ref-shaped word', async () => {
    const result = await normalizeAgentBrowserSnapshot({
      snapshot: ['- status', '  - StaticText "retry in e3 seconds"'].join('\n'),
      refs: {},
    });

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({ type: 'StaticText', value: 'retry in e3 seconds' });
    expect(result.nodes[0]?.ref).toBeUndefined();
  });
});
