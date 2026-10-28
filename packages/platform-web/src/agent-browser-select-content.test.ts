import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildSelectFocusedContentEvalScript,
  readSelectFocusedContentOutcome,
} from './agent-browser-select-content.ts';

// A fake DOM proves the script's decisions only. That the browser really selects the content, in
// shadow roots and frames, is proved by test/integration/smoke-web-fill.test.ts.

type FakeElement = Record<string, any>;
type FakeSelection = { ranges: { selectedNode: unknown }[]; selection: Record<string, any> };

function fakeSelection(): FakeSelection {
  const state: FakeSelection = { ranges: [], selection: {} };
  state.selection = {
    removeAllRanges: () => (state.ranges = []),
    addRange: (range: { selectedNode: unknown }) => state.ranges.push(range),
    get rangeCount() {
      return state.ranges.length;
    },
    getRangeAt: (index: number) => state.ranges[index],
  };
  return state;
}

function fakeDocument(selection = fakeSelection()): Record<string, any> {
  const doc: Record<string, any> = {
    activeElement: null,
    hit: null,
    elementFromPoint: () => doc.hit,
    createRange: () => {
      const range: Record<string, any> = {
        compareBoundaryPoints: () => 0,
        setStart: () => {},
        setEnd: () => {},
      };
      range.selectNodeContents = (node: unknown) => (range.selectedNode = node);
      return range;
    },
    defaultView: { getSelection: () => selection.selection },
  };
  return doc;
}

function fakeElement(doc: Record<string, any>, props: FakeElement): FakeElement {
  const element: FakeElement = {
    contains: (other: unknown) => other === element,
    childNodes: [],
    getRootNode: () => doc,
    ...props,
  };
  return element;
}

function runInPage(doc: Record<string, any>): string {
  const run = new Function('document', `return ${buildSelectFocusedContentEvalScript(5, 6)}`);
  return run(doc);
}

function pageWithFocusedAndHit(
  props: FakeElement,
  hitIsFocused = true,
): {
  doc: Record<string, any>;
  focused: FakeElement;
  selection: FakeSelection;
} {
  const selection = fakeSelection();
  const doc = fakeDocument(selection);
  const focused = fakeElement(doc, props);
  doc.activeElement = focused;
  doc.hit = hitIsFocused ? focused : fakeElement(doc, { tagName: 'DIV' });
  return { doc, focused, selection };
}

test('page script selects the content of a clicked text control', () => {
  let selected = 0;
  const { doc } = pageWithFocusedAndHit({
    tagName: 'INPUT',
    type: 'text',
    value: 'old',
    selectionStart: 0,
    selectionEnd: 3,
    select: () => (selected += 1),
  });
  assert.equal(runInPage(doc), 'selected');
  assert.equal(selected, 1);
});

test('page script selects exactly the content of a clicked contenteditable', () => {
  const { doc, focused, selection } = pageWithFocusedAndHit({
    tagName: 'DIV',
    isContentEditable: true,
  });
  assert.equal(runInPage(doc), 'selected');
  assert.deepEqual(
    selection.ranges.map((range) => range.selectedNode),
    [focused],
  );
});

test('page script selects through the focused same-origin frame own selection', () => {
  const frameSelection = fakeSelection();
  const frameDoc = fakeDocument(frameSelection);
  const field = fakeElement(frameDoc, { tagName: 'DIV', isContentEditable: true });
  frameDoc.activeElement = field;
  frameDoc.hit = field;
  const topSelection = fakeSelection();
  const doc = fakeDocument(topSelection);
  const frame = fakeElement(doc, {
    tagName: 'IFRAME',
    contentDocument: frameDoc,
    clientLeft: 0,
    clientTop: 0,
    getBoundingClientRect: () => ({ left: 1, top: 2 }),
  });
  doc.activeElement = frame;
  doc.hit = frame;
  assert.equal(runInPage(doc), 'selected');
  assert.deepEqual(
    frameSelection.ranges.map((range) => range.selectedNode),
    [field],
  );
  assert.deepEqual(topSelection.ranges, []);
});

test('page script refuses a focused field the click did not reach', () => {
  const { doc, selection } = pageWithFocusedAndHit(
    { tagName: 'DIV', isContentEditable: true },
    false,
  );
  assert.equal(runInPage(doc), 'not-clicked');
  assert.deepEqual(selection.ranges, []);
});

test('page script refuses focus it cannot reach inside a cross-origin frame', () => {
  const doc = fakeDocument();
  const frame = fakeElement(doc, { tagName: 'IFRAME', contentDocument: null });
  doc.activeElement = frame;
  doc.hit = frame;
  assert.equal(runInPage(doc), 'frame-unreachable');
});

test('page script refuses a focused element that is not a text-entry field', () => {
  const unsupported: FakeElement[] = [
    { tagName: 'INPUT', type: 'date' },
    { tagName: 'INPUT', type: 'color' },
    { tagName: 'INPUT', type: 'range' },
    { tagName: 'INPUT', type: 'checkbox' },
    { tagName: 'INPUT', type: 'text', readOnly: true },
    { tagName: 'INPUT', type: 'text', disabled: true },
    { tagName: 'TEXTAREA', readOnly: true },
    { tagName: 'SELECT' },
    { tagName: 'BUTTON' },
    { tagName: 'DIV', isContentEditable: false },
  ];
  for (const props of unsupported) {
    const { doc } = pageWithFocusedAndHit({ select: () => {}, ...props });
    assert.equal(runInPage(doc), 'not-editable', JSON.stringify(props));
  }
});

test('page script reports a selection the browser did not keep', () => {
  const { doc, selection } = pageWithFocusedAndHit({ tagName: 'DIV', isContentEditable: true });
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
    const { doc, selection } = pageWithFocusedAndHit({ tagName: 'DIV', isContentEditable: true });
    const addRange = selection.selection.addRange;
    selection.selection.addRange = (range: Record<string, any>) => {
      const compare = range.compareBoundaryPoints;
      range.compareBoundaryPoints = (how: number) => (how === boundary ? comparison : compare());
      addRange(range);
    };
    assert.equal(runInPage(doc), expected, `${boundary} ${comparison}`);
  }
});

test('page script trusts select() for inputs without a selection API and checks the rest', () => {
  const control = (type: string, selectionStart: number | null) => ({
    tagName: 'INPUT',
    type,
    value: 'old',
    selectionStart,
    selectionEnd: selectionStart === null ? null : 3,
    select: () => {},
  });
  assert.equal(runInPage(pageWithFocusedAndHit(control('email', null)).doc), 'selected');
  assert.equal(runInPage(pageWithFocusedAndHit(control('number', null)).doc), 'selected');
  assert.equal(runInPage(pageWithFocusedAndHit(control('text', 0)).doc), 'selected');
  // A text input whose selection did not cover the value must not pass as selected.
  assert.equal(runInPage(pageWithFocusedAndHit(control('text', 1)).doc), 'selection-failed');
  assert.equal(runInPage(pageWithFocusedAndHit(control('text', null)).doc), 'selection-failed');
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
