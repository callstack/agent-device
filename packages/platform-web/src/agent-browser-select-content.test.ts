import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SELECT_FOCUSED_CONTENT_EVAL_SCRIPT } from './agent-browser-select-content.ts';

class FakeTextControl {
  selected = false;
  select(): void {
    this.selected = true;
  }
}

type FakePage = {
  activeElement: unknown;
  ranges: unknown[];
  result: unknown;
};

function runInPage(
  activeElement: unknown,
  classes: { input: unknown; textarea: unknown } = { input: FakeTextControl, textarea: class {} },
): FakePage {
  const page: FakePage = { activeElement, ranges: [], result: undefined };
  const selection = {
    removeAllRanges: () => (page.ranges = []),
    addRange: (range: unknown) => page.ranges.push(range),
  };
  const document = {
    activeElement,
    createRange: () => ({
      selectNodeContents: (node: unknown) => ({ selectedNode: node }),
    }),
  };
  const run = new Function(
    'document',
    'window',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    `return ${SELECT_FOCUSED_CONTENT_EVAL_SCRIPT}`,
  );
  page.result = run(document, { getSelection: () => selection }, classes.input, classes.textarea);
  return page;
}

test('page selection script selects the content of a focused text control', () => {
  const input = new FakeTextControl();
  const page = runInPage(input);
  assert.equal(page.result, true);
  assert.equal(input.selected, true);
});

test('page selection script selects the content of a focused contenteditable', () => {
  const editable = { isContentEditable: true };
  const page = runInPage(editable);
  assert.equal(page.result, true);
  assert.equal(page.ranges.length, 1);
});

test('page selection script follows focus into a shadow root', () => {
  const input = new FakeTextControl();
  const page = runInPage({ shadowRoot: { activeElement: input } });
  assert.equal(page.result, true);
  assert.equal(input.selected, true);
});

test('page selection script does nothing when focus is not on an editable element', () => {
  const body = { isContentEditable: false };
  const page = runInPage(body);
  assert.equal(page.result, false);
  assert.equal(page.ranges.length, 0);
});
