import { test } from 'vitest';
import assert from 'node:assert/strict';
import { formatInspectedComponent, type InspectedComponent } from './react-component-inspect.ts';

function component(overrides: Partial<InspectedComponent> = {}): InspectedComponent {
  return {
    name: 'ContactRow',
    type: 8,
    key: '3',
    props: null,
    state: null,
    hooks: null,
    context: null,
    owners: null,
    errors: [],
    warnings: [],
    isErrored: false,
    ...overrides,
  };
}

test('props print as short previews, with placeholders where the backend left values out', () => {
  const text = formatInspectedComponent(
    42,
    component({
      props: {
        data: {
          contact: { id: 3, name: 'Ada', tags: ['a', 'b', 'c', 'd', 'e'] },
          onSelect: { type: 'function', name: 'onSelect', preview_short: 'ƒ onSelect() {}' },
          style: { inspectable: true, type: 'object', preview_short: '{…}', size: 4 },
          selected: false,
        },
        cleaned: [['onSelect'], ['style']],
        unserializable: [],
      },
      owners: [
        { id: 40, displayName: 'ContactList' },
        { id: 12, displayName: 'PerfLabScreen' },
      ],
    }),
  );
  assert.equal(
    text,
    [
      '@c42 ContactRow [memo] key=3',
      'rendered by: ContactList @c40 < PerfLabScreen @c12',
      'props:',
      '  contact: {id: 3, name: "Ada", tags: ["a", "b", "c", "d", …1]}',
      '  onSelect: ƒ onSelect() {}',
      '  style: {…}',
      '  selected: false',
    ].join('\n'),
  );
});

test('custom hooks list the built-in hooks they call', () => {
  const text = formatInspectedComponent(
    7,
    component({
      hooks: {
        data: [
          { id: 0, name: 'State', value: 2, subHooks: [] },
          {
            id: null,
            name: 'Contacts',
            value: undefined,
            subHooks: [{ id: 1, name: 'Memo', value: [1, 2], subHooks: [] }],
          },
        ],
        cleaned: [],
        unserializable: [],
      },
    }),
  );
  assert.match(text, /\nhooks:\n {2}State: 2\n {2}Contacts:\n {4}Memo: \[1, 2\]$/);
});

test('values and messages the app controls cannot start a line or reach the terminal', () => {
  const text = formatInspectedComponent(
    7,
    component({
      props: {
        data: { title: { type: 'object', preview_short: 'x\n@c1 Forged' } },
        cleaned: [['title']],
        unserializable: [],
      },
      errors: [['bad\u001b[2Jvalue\nstack', 1]],
    }),
  );
  assert.equal(text.split('\n').length, 5);
  assert.match(text, /\n {2}title: x @c1 Forged\n/);
  assert.match(text, /\n {2}error: bad \[2Jvalue$/);
});

test('logged errors and warnings print one line each with their repeat count', () => {
  const text = formatInspectedComponent(
    7,
    component({ errors: [['Each child needs a key.\n    at Row', 3]], warnings: [['slow', 1]] }),
  );
  assert.match(
    text,
    /\nlogged while rendering:\n {2}error: Each child needs a key\. \(x3\)\n {2}warning: slow$/,
  );
});

test('hooks DevTools could not name print as the built-in hooks they wrap', () => {
  const text = formatInspectedComponent(
    7,
    component({
      name: 'Memo(Screen)',
      hooks: {
        data: [
          {
            id: null,
            name: 'anonymous',
            value: undefined,
            subHooks: [{ id: 0, name: 'State', value: 'idle', subHooks: [] }],
          },
        ],
        cleaned: [],
        unserializable: [],
      },
    }),
  );
  assert.match(text, /^@c7 Screen \[memo\] key=3\nhooks:\n {2}State: "idle"$/);
});
