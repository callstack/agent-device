import fc from 'fast-check';
import type { SelectorKey, SelectorTerm } from '../parse.ts';

export const PROPERTY_RUNS = 100;

const SELECTOR_KEY_VALUE_KINDS = {
  id: 'text',
  role: 'text',
  text: 'text',
  label: 'text',
  value: 'text',
  appname: 'text',
  windowtitle: 'text',
  visible: 'boolean',
  hidden: 'boolean',
  editable: 'boolean',
  selected: 'boolean',
  focused: 'boolean',
  enabled: 'boolean',
  hittable: 'boolean',
} satisfies Record<SelectorKey, 'text' | 'boolean'>;

const SELECTOR_KEY_NAMES: readonly SelectorKey[] = Object.keys(
  SELECTOR_KEY_VALUE_KINDS,
) as SelectorKey[];

function selectorKeysOfKind(kind: 'text' | 'boolean'): SelectorKey[] {
  return SELECTOR_KEY_NAMES.filter((key) => SELECTOR_KEY_VALUE_KINDS[key] === kind);
}

const SELECTOR_VALUE_HAZARDS = [
  '',
  ' ',
  '"',
  "'",
  "it's",
  'say "hi"',
  '\\',
  String.raw`\"`,
  String.raw`a\\b`,
  'a || b',
  'key=value',
  'line\nbreak',
  '\tTab',
  'Ünïcøde',
  '😀 emoji',
] as const;

const selectorTextValueArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...SELECTOR_VALUE_HAZARDS),
  fc.string({ minLength: 0, maxLength: 12 }),
  fc
    .array(fc.constantFrom(...SELECTOR_VALUE_HAZARDS), { minLength: 2, maxLength: 3 })
    .map((parts) => parts.join('')),
);

const selectorTermArb: fc.Arbitrary<SelectorTerm> = fc.oneof(
  fc
    .record({
      key: fc.constantFrom(...selectorKeysOfKind('text')),
      value: selectorTextValueArb,
    })
    .map(({ key, value }) => ({ key, value })),
  fc
    .record({
      key: fc.constantFrom(...selectorKeysOfKind('boolean')),
      value: fc.boolean(),
    })
    .map(({ key, value }) => ({ key, value })),
);

export type GeneratedSelectorChain = {
  selectors: SelectorTerm[][];
  expression: string;
};

export const selectorChainArb: fc.Arbitrary<GeneratedSelectorChain> = fc
  .record({
    selectors: fc.array(fc.array(selectorTermArb, { minLength: 1, maxLength: 4 }), {
      minLength: 1,
      maxLength: 3,
    }),
    bareBooleans: fc.boolean(),
  })
  .map(({ selectors, bareBooleans }) => ({
    selectors,
    expression: formatSelectorChainExpression(selectors, { bareBooleans }),
  }));

function formatSelectorTerm(term: SelectorTerm, options: { bareBooleans?: boolean } = {}): string {
  if (typeof term.value === 'boolean') {
    return options.bareBooleans && term.value ? term.key : `${term.key}=${term.value}`;
  }
  return `${term.key}=${JSON.stringify(term.value)}`;
}

export function formatSelectorChainExpression(
  selectors: readonly (readonly SelectorTerm[])[],
  options: { bareBooleans?: boolean } = {},
): string {
  return selectors
    .map((terms) => terms.map((term) => formatSelectorTerm(term, options)).join(' '))
    .join(' || ');
}
