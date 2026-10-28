import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import {
  buildSelectFocusedContentEvalScript,
  readSelectFocusedContentOutcome,
  selectFocusedContent,
} from './agent-browser-select-content.ts';

// A fake DOM proves the script's decisions only. That the browser really selects the content, in
// shadow roots and frames, is proved by the live fill scenario in test/integration/web-e2e.

type Fake = Record<string, any>;
type FakeSelection = { ranges: Fake[]; selection: Fake };

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeSelection(): FakeSelection {
  const state: FakeSelection = { ranges: [], selection: {} };
  state.selection = {
    removeAllRanges: () => (state.ranges = []),
    addRange: (range: Fake) => state.ranges.push(range),
    get rangeCount() {
      return state.ranges.length;
    },
    getRangeAt: (index: number) => state.ranges[index],
  };
  return state;
}

function fakeDocument(selection = fakeSelection()): Fake {
  const doc: Fake = {
    activeElement: null,
    hit: null,
    elementFromPoint: () => doc.hit,
    createRange: () => {
      const range: Fake = {
        compareBoundaryPoints: () => 0,
        setStart: (node: unknown, offset: number) => (range.start = { node, offset }),
        setEnd: (node: unknown, offset: number) => (range.end = { node, offset }),
      };
      range.selectNodeContents = (node: unknown) => (range.selectedNode = node);
      return range;
    },
    defaultView: { getSelection: () => selection.selection },
  };
  return doc;
}

function fakeElement(doc: Fake, props: Fake): Fake {
  const element: Fake = {
    contains: (other: unknown) => other === element,
    childNodes: [],
    getRootNode: () => doc,
    ...props,
  };
  return element;
}

function runInPage(doc: Fake): string {
  vi.stubGlobal('document', doc);
  return selectFocusedContent(5, 6);
}

function page(props: Fake, hitIsFocused = true) {
  const selection = fakeSelection();
  const doc = fakeDocument(selection);
  const focused = fakeElement(doc, props);
  doc.activeElement = focused;
  doc.hit = hitIsFocused ? focused : fakeElement(doc, { tagName: 'DIV' });
  return { doc, focused, selection };
}

function textControl(type: string, extra: Fake = {}): Fake {
  return {
    tagName: 'INPUT',
    type,
    value: 'old',
    selectionStart: 0,
    selectionEnd: 3,
    select: () => {},
    ...extra,
  };
}

function frameElement(
  doc: Fake,
  frameDoc: Fake | null,
  layout: Fake = {},
  tagName = 'IFRAME',
): Fake {
  return fakeElement(doc, {
    tagName,
    contentDocument: frameDoc,
    clientLeft: 0,
    clientTop: 0,
    offsetWidth: 100,
    offsetHeight: 100,
    getBoundingClientRect: () => ({ left: 1, top: 2, width: 100, height: 100 }),
    ...layout,
  });
}

test('page script selects the content of a clicked text control', () => {
  let selected = 0;
  const { doc } = page(textControl('text', { select: () => (selected += 1) }));
  assert.equal(runInPage(doc), 'selected');
  assert.equal(selected, 1);
});

test('page script selects a clicked textarea', () => {
  const { doc } = page(textControl('', { tagName: 'TEXTAREA' }));
  assert.equal(runInPage(doc), 'selected');
});

test('page script accepts exactly the text-entry input types', () => {
  for (const type of ['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'TEXT']) {
    const selectionStart = ['email', 'number'].includes(type) ? null : 0;
    const { doc } = page(textControl(type, { selectionStart }));
    assert.equal(runInPage(doc), 'selected', type);
  }
  for (const type of ['date', 'color', 'range', 'checkbox', 'radio', 'file', 'button']) {
    assert.equal(runInPage(page(textControl(type)).doc), 'not-editable', type);
  }
});

test('page script refuses a read-only, disabled, or non-field focused element', () => {
  const unsupported: Fake[] = [
    textControl('text', { readOnly: true }),
    textControl('text', { disabled: true }),
    { tagName: 'TEXTAREA', readOnly: true },
    { tagName: 'TEXTAREA', disabled: true },
    { tagName: 'SELECT' },
    { tagName: 'BUTTON' },
    { tagName: 'DIV', isContentEditable: false },
  ];
  for (const props of unsupported) {
    assert.equal(runInPage(page(props).doc), 'not-editable', JSON.stringify(props));
  }
});

test('page script refuses when nothing is focused', () => {
  assert.equal(runInPage(fakeDocument()), 'not-editable');
});

test('page script selects exactly the content of a clicked contenteditable', () => {
  const { doc, focused, selection } = page({ tagName: 'DIV', isContentEditable: true });
  assert.equal(runInPage(doc), 'selected');
  assert.deepEqual(
    selection.ranges.map((range) => range.selectedNode),
    [focused],
  );
});

test('page script refuses a focused field the click did not reach', () => {
  const { doc, selection } = page({ tagName: 'DIV', isContentEditable: true }, false);
  assert.equal(runInPage(doc), 'not-clicked');
  assert.deepEqual(selection.ranges, []);
});

test('page script refuses a click that hit nothing', () => {
  const { doc } = page({ tagName: 'DIV', isContentEditable: true });
  doc.hit = null;
  assert.equal(runInPage(doc), 'not-clicked');
});

test('page script accepts a click on an element inside the focused contenteditable', () => {
  const { doc, focused } = page({ tagName: 'DIV', isContentEditable: true });
  const child = fakeElement(doc, { tagName: 'P' });
  focused.contains = (other: unknown) => other === focused || other === child;
  doc.hit = child;
  assert.equal(runInPage(doc), 'selected');
});

test('page script accepts a click on the label of the focused control only', () => {
  const { doc, focused } = page(textControl('text'));
  doc.hit = fakeElement(doc, {
    tagName: 'SPAN',
    closest: (selector: string) => (selector === 'label' ? { control: focused } : null),
  });
  assert.equal(runInPage(doc), 'selected');
  doc.hit = fakeElement(doc, { tagName: 'SPAN', closest: () => ({ control: {} }) });
  assert.equal(runInPage(doc), 'not-clicked');
});

test('page script selects through the focused same-origin frame own selection', () => {
  const frameSelection = fakeSelection();
  const frameDoc = fakeDocument(frameSelection);
  const field = fakeElement(frameDoc, { tagName: 'DIV', isContentEditable: true });
  frameDoc.activeElement = field;
  const pointsSeen: number[][] = [];
  frameDoc.elementFromPoint = (x: number, y: number) => (pointsSeen.push([x, y]), field);
  const topSelection = fakeSelection();
  const doc = fakeDocument(topSelection);
  const frame = frameElement(doc, frameDoc);
  doc.activeElement = frame;
  doc.hit = frame;
  assert.equal(runInPage(doc), 'selected');
  assert.deepEqual(pointsSeen, [[4, 4]]);
  assert.deepEqual(
    frameSelection.ranges.map((range) => range.selectedNode),
    [field],
  );
  assert.deepEqual(topSelection.ranges, []);
});

test('page script maps the click into a scaled frame by its rendered-to-layout ratio', () => {
  // [rendered size, layout size, border, expected local point for viewport (11, 12) with the frame at (1, 2)]
  const cases = [
    [50, 100, 0, [20, 20]],
    [200, 100, 0, [5, 5]],
    [100, 100, 3, [7, 7]],
    [0, 0, 0, [10, 10]],
  ] as const;
  for (const [rendered, layout, border, expected] of cases) {
    const frameDoc = fakeDocument();
    const field = fakeElement(frameDoc, { tagName: 'DIV', isContentEditable: true });
    frameDoc.activeElement = field;
    const pointsSeen: number[][] = [];
    frameDoc.elementFromPoint = (x: number, y: number) => (pointsSeen.push([x, y]), field);
    const doc = fakeDocument();
    const frame = frameElement(doc, frameDoc, {
      offsetWidth: layout,
      offsetHeight: layout,
      clientLeft: border,
      clientTop: border,
      getBoundingClientRect: () => ({ left: 1, top: 2, width: rendered, height: rendered }),
    });
    doc.activeElement = frame;
    doc.hit = frame;
    vi.stubGlobal('document', doc);
    assert.equal(selectFocusedContent(11, 12), 'selected');
    assert.deepEqual(pointsSeen, [[...expected]]);
  }
});

test('page script refuses a focused frame it cannot read', () => {
  const doc = fakeDocument();
  const blocked = frameElement(doc, null);
  doc.activeElement = blocked;
  doc.hit = blocked;
  assert.equal(runInPage(doc), 'frame-unreachable');

  const throwing = fakeElement(doc, { tagName: 'FRAME' });
  Object.defineProperty(throwing, 'contentDocument', {
    get() {
      throw new Error('cross-origin');
    },
  });
  doc.activeElement = throwing;
  assert.equal(runInPage(doc), 'frame-unreachable');
});

test('page script refuses a click point inside a frame it cannot read or that holds nothing', () => {
  const { doc } = page(textControl('text'));
  doc.hit = frameElement(doc, null);
  assert.equal(runInPage(doc), 'frame-unreachable');

  const emptyFrameDoc = fakeDocument();
  emptyFrameDoc.hit = null;
  doc.hit = frameElement(doc, emptyFrameDoc);
  assert.equal(runInPage(doc), 'not-clicked');
});

test('page script follows focus and the click into an open shadow root', () => {
  const { doc } = page({ tagName: 'DIV' });
  const input = fakeElement(doc, textControl('text'));
  const host = fakeElement(doc, {
    tagName: 'DIV',
    shadowRoot: { activeElement: input, elementFromPoint: () => input },
  });
  doc.activeElement = host;
  doc.hit = host;
  assert.equal(runInPage(doc), 'selected');
});

test('page script cannot see into a closed shadow root and refuses', () => {
  const { doc } = page({ tagName: 'DIV' });
  const host = fakeElement(doc, { tagName: 'DIV', shadowRoot: null });
  doc.activeElement = host;
  doc.hit = host;
  assert.equal(runInPage(doc), 'not-editable');
});

test('page script selects an open-shadow contenteditable through the shadow root selection', () => {
  const shadowSelection = fakeSelection();
  const { doc, focused, selection } = page({ tagName: 'DIV', isContentEditable: true });
  focused.getRootNode = () => ({ getSelection: () => shadowSelection.selection });
  assert.equal(runInPage(doc), 'selected');
  assert.deepEqual(
    shadowSelection.ranges.map((range) => range.selectedNode),
    [focused],
  );
  assert.deepEqual(selection.ranges, []);
});

test('page script reports a selection the browser did not keep', () => {
  const { doc, selection } = page({ tagName: 'DIV', isContentEditable: true });
  selection.selection.addRange = () => {};
  assert.equal(runInPage(doc), 'selection-failed');
});

test('page script judges a kept selection by boundary points, not by text', () => {
  const start = 0;
  const end = 2;
  // A kept range that starts after, or ends before, the host content leaves some of it unselected.
  for (const [boundary, comparison, expected] of [
    [start, 1, 'selection-failed'],
    [end, -1, 'selection-failed'],
    [start, -1, 'selected'],
    [end, 1, 'selected'],
  ] as const) {
    const { doc, selection } = page({ tagName: 'DIV', isContentEditable: true });
    const addRange = selection.selection.addRange;
    selection.selection.addRange = (range: Fake) => {
      const compare = range.compareBoundaryPoints;
      range.compareBoundaryPoints = (how: number) => (how === boundary ? comparison : compare());
      addRange(range);
    };
    assert.equal(runInPage(doc), expected, `${boundary} ${comparison}`);
  }
});

test('page script compares against the innermost content of the host', () => {
  const { doc, focused } = page({ tagName: 'DIV', isContentEditable: true });
  const first = { nodeType: 3, data: 'one', childNodes: [] };
  const last = { nodeType: 3, data: 'hidden!', childNodes: [] };
  const paragraph = (text: Fake) => ({
    nodeType: 1,
    firstChild: text,
    lastChild: text,
    childNodes: [text],
  });
  focused.firstChild = paragraph(first);
  focused.lastChild = paragraph(last);
  focused.childNodes = [focused.firstChild, focused.lastChild];
  const created: Fake[] = [];
  const createRange = doc.createRange;
  doc.createRange = () => created[created.push(createRange()) - 1];
  assert.equal(runInPage(doc), 'selected');
  const content = created[1];
  assert.deepEqual(content?.start, { node: first, offset: 0 });
  assert.deepEqual(content?.end, { node: last, offset: 7 });
});

test('page script trusts select() for inputs without a selection API and checks the rest', () => {
  const control = (type: string, selectionStart: number | null, selectionEnd = 3) =>
    textControl(type, {
      selectionStart,
      selectionEnd: selectionStart === null ? null : selectionEnd,
    });
  assert.equal(runInPage(page(control('email', null)).doc), 'selected');
  assert.equal(runInPage(page(control('number', null)).doc), 'selected');
  assert.equal(runInPage(page(control('text', 0)).doc), 'selected');
  // A text input whose selection did not cover the value must not pass as selected.
  assert.equal(runInPage(page(control('text', 1)).doc), 'selection-failed');
  assert.equal(runInPage(page(control('text', null)).doc), 'selection-failed');
  // A selection that starts at 0 but ends before the end of the value leaves text unselected.
  assert.equal(runInPage(page(control('text', 0, 2)).doc), 'selection-failed');
});

test('the serialized page script runs the same functions the unit tests call', () => {
  const { doc } = page(textControl('text'));
  const run = new Function('document', `return ${buildSelectFocusedContentEvalScript(5.4, 6.6)}`);
  assert.equal(run(doc), 'selected');
});

test('selection outcome reads the backend result and treats anything else as no answer', () => {
  assert.deepEqual(readSelectFocusedContentOutcome({ result: 'selected' }), {
    selected: true,
    cause: 'selected',
  });
  assert.deepEqual(readSelectFocusedContentOutcome({ result: 'not-clicked' }), {
    selected: false,
    cause: 'not-clicked',
  });
  assert.deepEqual(readSelectFocusedContentOutcome({}), { selected: false, cause: 'no-answer' });
});
