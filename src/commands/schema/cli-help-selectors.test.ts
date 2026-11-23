import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { SELECTOR_KEY_NAMES } from '@agent-device/selectors';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  isCommandName,
  listCommandMetadata,
  readInputFromCli,
} from '@agent-device/command-surface';
import { parseArgs } from '../../cli/parser/args.ts';
import { listSelectorChainMatches, parseSelectorChain } from '../../sdk/selectors.ts';
import { selectorsHelpTopic } from './cli-help-selectors.ts';

// `help selectors` and selectors.md state the selector rules in hand-written prose. These tests pin
// the selectors those texts show: each command example parses, each rule example still appears in
// both texts and gets the result the test expects from the parser and matcher, each parser key
// is the subject of a rule, and the commands named as taking a selector match the command surface.
// They do not read the prose around an example, so a reworded rule that keeps its example is not
// caught.

const HELP = selectorsHelpTopic.body;
const DOC = fs.readFileSync(
  path.join(import.meta.dirname, '../../../website/docs/docs/selectors.md'),
  'utf8',
);
const SOURCES = { 'help selectors': HELP, 'selectors.md': DOC } as const;

/** The single-quoted selector of each `agent-device ...` example line. */
function commandExampleSelectors(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('agent-device '))
    .flatMap((line) => [...line.matchAll(/'([^']*=[^']*)'/g)].map(([, selector]) => selector!));
}

function labels(nodes: SnapshotNode[], expression: string): Array<string | undefined> {
  const match = listSelectorChainMatches(nodes, parseSelectorChain(expression), {
    platform: 'ios',
  });
  return match?.matchedNodes.map((node) => node.label) ?? [];
}

function node(index: number, fields: Partial<SnapshotNode>): SnapshotNode {
  return { index, ref: `e${index + 1}`, ...fields };
}

test.each(Object.entries(SOURCES))('every command example selector in %s parses', (_, text) => {
  const selectors = commandExampleSelectors(text);
  assert.ok(selectors.length >= 4, `expected command examples, found ${selectors.length}`);
  for (const selector of selectors) {
    assert.doesNotThrow(() => parseSelectorChain(selector), selector);
  }
});

/** The keys a rule clause is about: `id is ...`, `label and value are ...`, `a, b, and c test ...`. */
function ruleSubjects(text: string): Set<string> {
  const clauses = text.split('\n').flatMap((line) => line.trim().split(/[;.] /));
  const subjects = clauses.flatMap(
    (clause) =>
      /^([a-z]+(?:, [a-z]+)*(?:,? and [a-z]+)?) (?:is|are|tests?) /.exec(clause)?.[1] ?? [],
  );
  return new Set(subjects.flatMap((subject) => subject.split(/,? and |, /)));
}

// The Keys line is generated from the parser, so a new key shows up there with no rule. Each key
// must open a rule clause in the Matching section.
test('every selector key opens a rule clause in the help Matching section', () => {
  const matching = HELP.slice(HELP.indexOf('Matching:'));
  const subjects = ruleSubjects(matching);
  for (const key of SELECTOR_KEY_NAMES) {
    assert.ok(subjects.has(key), `no Matching clause starts with ${key}`);
  }
});

// selectors.md gives a text key a table row and a boolean key a place on the Boolean keys line.
test('every selector key has a table row or a Boolean keys entry in selectors.md', () => {
  const booleanLine = DOC.split('\n').find((line) => line.startsWith('Boolean keys:')) ?? '';
  for (const key of SELECTOR_KEY_NAMES) {
    const row = DOC.split('\n').some((line) => line.startsWith(`| \`${key}\` `));
    assert.ok(row || booleanLine.includes(`\`${key}\``), `${key} has no rule in selectors.md`);
  }
});

const SELECTOR = 'label="Photo"';

/** Commands whose input takes its UI target as a `selector` field. */
function selectorTargetCommands(): string[] {
  return listCommandMetadata()
    .filter((meta) => 'selector' in (meta.inputSchema.properties ?? {}))
    .map((meta) => meta.name)
    .sort();
}

test('both texts list exactly the commands whose input has a selector target', () => {
  const helpList = /\. ([a-z, ]+) take a selector as the target/.exec(HELP)?.[1] ?? '';
  const docLine = DOC.split('\n').find((line) => line.endsWith(', as the target')) ?? '';
  const docList = [...docLine.matchAll(/`([a-z]+)`/g)].map(([, name]) => name);
  assert.deepEqual(helpList.split(/,? and |, /).sort(), selectorTargetCommands());
  assert.deepEqual(docList.sort(), selectorTargetCommands());
});

// The other inputs that take a selector, each with the CLI spelling the texts use for it.
const OTHER_SELECTOR_INPUTS = [
  { spelling: 'find', field: 'query', argv: ['find', SELECTOR, 'exists'] },
  { spelling: 'scroll --until', field: 'until', argv: ['scroll', 'down', '--until', SELECTOR] },
  {
    spelling: 'screenshot --crop-on',
    field: 'cropOn',
    argv: ['screenshot', '--crop-on', SELECTOR],
  },
  { spelling: 'gesture pinch', field: 'element', argv: ['gesture', 'pinch', '2', SELECTOR] },
  { spelling: 'gesture drag', field: 'source', argv: ['gesture', 'drag', SELECTOR, 'id="bin"'] },
  {
    spelling: 'gesture drag',
    field: 'destination',
    argv: ['gesture', 'drag', 'id="bin"', SELECTOR],
  },
] as const;

test.each(OTHER_SELECTOR_INPUTS)(
  '$spelling reads a selector into $field and both texts name it',
  ({ spelling, field, argv }) => {
    const parsed = parseArgs([...argv], { strictFlags: true });
    assert.ok(parsed.command && isCommandName(parsed.command));
    const input = readInputFromCli(parsed.command, parsed.positionals, parsed.flags);
    assert.equal(input[field], SELECTOR);
    for (const [source, text] of Object.entries(SOURCES)) {
      assert.ok(text.includes(spelling), `${source} does not name ${spelling}`);
    }
  },
);

// A selector-valued field documents itself as one. The target fields, and the snapshot options that
// steer target resolution, mention selectors without taking one.
const NOT_SELECTOR_VALUED = new Set(['selector', 'ref', 'x', 'y', 'scope', 'raw']);

test('every other input field described as a selector is listed above', () => {
  const listed = new Set(OTHER_SELECTOR_INPUTS.map(({ field, argv }) => `${argv[0]}.${field}`));
  for (const meta of listCommandMetadata()) {
    for (const [field, schema] of Object.entries(meta.inputSchema.properties ?? {})) {
      if (NOT_SELECTOR_VALUED.has(field)) continue;
      const description = (schema as { description?: string }).description ?? '';
      if (!/selector/i.test(description)) continue;
      const name = `${meta.name}.${field}`;
      assert.ok(listed.has(name), `${name} takes a selector but is not listed`);
    }
  }
});

const RULE_EXAMPLES: ReadonlyArray<{ example: string; check: (example: string) => void }> = [
  {
    // A bare boolean key is a term of its own, the same as key=true.
    example: 'role=switch checked',
    check: (example) =>
      assert.deepEqual(parseSelectorChain(example).selectors[0]?.terms, [
        { key: 'role', value: 'switch' },
        { key: 'checked', value: true },
      ]),
  },
  {
    example: 'visible=false',
    check: (example) =>
      assert.deepEqual(parseSelectorChain(example).selectors[0]?.terms, [
        { key: 'visible', value: false },
      ]),
  },
  {
    example: 'role=button label="Save"',
    check: (example) =>
      assert.deepEqual(parseSelectorChain(example).selectors[0]?.terms, [
        { key: 'role', value: 'button' },
        { key: 'label', value: 'Save' },
      ]),
  },
  {
    example: 'button="Save"',
    check: (example) => assert.throws(() => parseSelectorChain(example), /Unknown selector key/),
  },
  {
    example: 'label="Say \\"hi\\""',
    check: (example) =>
      assert.deepEqual(parseSelectorChain(example).selectors[0]?.terms, [
        { key: 'label', value: 'Say "hi"' },
      ]),
  },
  {
    example: 'label="sign in"',
    check: (example) =>
      assert.deepEqual(
        labels([node(0, { label: 'Sign In' }), node(1, { label: 'Sign In Now' })], example),
        ['Sign In'],
      ),
  },
  {
    // Neither an unchecked control nor one without a checked state matches checked=true.
    example: 'checked=true',
    check: (example) =>
      assert.deepEqual(
        labels(
          [
            node(0, { label: 'On', checked: true }),
            node(1, { label: 'Off', checked: false }),
            node(2, { label: 'Plain' }),
          ],
          example,
        ),
        ['On'],
      ),
  },
  {
    example: 'checked=false',
    check: (example) =>
      assert.deepEqual(
        labels(
          [
            node(0, { label: 'On', checked: true }),
            node(1, { label: 'Off', checked: false }),
            node(2, { label: 'Plain' }),
          ],
          example,
        ),
        ['Off'],
      ),
  },
  {
    // The left alternative wins when both resolve; the right one is used when the left finds nothing.
    example: 'id="submit" || label="Submit order"',
    check: (example) => {
      const both = [node(0, { label: 'Submit order' }), node(1, { identifier: 'submit' })];
      const chain = parseSelectorChain(example);
      assert.equal(listSelectorChainMatches(both, chain, { platform: 'ios' })?.selectorIndex, 0);
      const labelOnly = [node(0, { label: 'Submit order' })];
      assert.equal(
        listSelectorChainMatches(labelOnly, chain, { platform: 'ios' })?.selectorIndex,
        1,
      );
    },
  },
];

test.each(RULE_EXAMPLES)(
  '$example appears in both texts and parses or matches as expected',
  ({ example, check }) => {
    for (const [source, text] of Object.entries(SOURCES)) {
      assert.ok(text.includes(example), `${source} no longer shows ${example}`);
    }
    check(example);
  },
);
