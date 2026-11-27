import assert from 'node:assert/strict';
import { test } from 'vitest';
import { formatPinnedRef, REF_PIN_SEPARATOR } from '@agent-device/kernel/snapshot';
import {
  appendWarningLinesText,
  collapseWarningText,
  pinnedRefText,
  routeResponseWarnings,
} from './output-common.ts';

const WARNING = 'The session app was not foreground when this command arrived.';

test('appendWarningLinesText renders the bare text when there are no warnings', () => {
  assert.equal(appendWarningLinesText('Replayed 3 steps', {}), 'Replayed 3 steps');
});

test('appendWarningLinesText appends one Warning line per string warning (#2560)', () => {
  assert.equal(
    appendWarningLinesText('Replayed 3 steps', {
      warnings: ['Optional Maestro tapOn skipped at flow.yaml:line 12', 42, null],
    }),
    'Replayed 3 steps\nWarning: Optional Maestro tapOn skipped at flow.yaml:line 12',
  );
});

test('appendWarningLinesText renders warnings even without text', () => {
  assert.equal(
    appendWarningLinesText(null, { warnings: ['capture degraded'] }),
    'Warning: capture degraded',
  );
});

test('appendWarningLinesText collapses newlines inside a warning', () => {
  assert.equal(
    appendWarningLinesText('Replayed 1 step', { warnings: ['line one\n  line two'] }),
    'Replayed 1 step\nWarning: line one line two',
  );
});

/**
 * The dedupe that lets a report builder keep its own notice line: the dispatcher runs after every
 * formatter, and a warning the text already carries must not be said twice.
 */
test('appendWarningLinesText appends every warning, even one the text already shows', () => {
  const text = `Snapshot: 15 visible nodes\n${WARNING}`;
  assert.equal(
    appendWarningLinesText(text, { warnings: [WARNING] }),
    `${text}\nWarning: ${WARNING}`,
  );
});

test('appendWarningLinesText returns the text unchanged without warnings', () => {
  assert.equal(appendWarningLinesText('Done', { warnings: [] }), 'Done');
  assert.equal(appendWarningLinesText(undefined, {}), null);
});

test('routeResponseWarnings appends to text for a report command', () => {
  assert.deepEqual(
    routeResponseWarnings(
      { data: {}, text: 'Passed: is visible' },
      { warnings: [WARNING] },
      'text',
    ),
    { data: {}, text: `Passed: is visible\nWarning: ${WARNING}` },
  );
});

/**
 * The stdout of a `parseableOutput` command IS the value a caller pipes onward, so the warning goes
 * to the other stream instead of corrupting it (#2682).
 */
test('routeResponseWarnings sends warnings to stderr for a parseable command', () => {
  const response = { text: 'General', warnings: [WARNING] };
  assert.deepEqual(
    routeResponseWarnings({ data: { text: 'General' }, text: 'General' }, response, 'stderr'),
    {
      data: { text: 'General' },
      text: 'General',
      stderr: `Warning: ${WARNING}\n`,
    },
  );
});

test('routeResponseWarnings keeps an existing stderr note and adds the warning once', () => {
  const output = routeResponseWarnings(
    { data: {}, text: '', stderr: 'AX snapshot unavailable\n' },
    { warnings: [WARNING] },
    'stderr',
  );
  assert.equal(output.text, '');
  assert.equal(output.stderr, `AX snapshot unavailable\nWarning: ${WARNING}\n`);
  assert.deepEqual(routeResponseWarnings(output, { message: 'done' }, 'stderr'), output);
});

/** A formatter that rebuilds its own data payload must not be able to swallow the channel (#2682). */
test('routeResponseWarnings reads warnings from the response, not the rendered data', () => {
  const output = routeResponseWarnings(
    { data: { closed: true }, text: 'Closed' },
    { warnings: [WARNING] },
    'text',
  );
  assert.equal(output.text, `Closed\nWarning: ${WARNING}`);
});

test('routeResponseWarnings leaves an output with nothing to warn about untouched', () => {
  const output = { data: { message: 'done' }, text: 'done' };
  assert.deepEqual(routeResponseWarnings(output, { message: 'done' }, 'text'), output);
  assert.deepEqual(routeResponseWarnings(output, { message: 'done' }, 'stderr'), output);
});

/** `--json` readers depend on `jsonData` surviving presentation. */
test('routeResponseWarnings preserves jsonData alongside a routed warning', () => {
  const output = routeResponseWarnings(
    { data: {}, jsonData: { warnings: [WARNING] }, text: 'ok' },
    { warnings: [WARNING] },
    'stderr',
  );
  assert.deepEqual(output.jsonData, { warnings: [WARNING] });
});

test('warning collapse preserves horizontal whitespace and folds newline-separated whitespace', () => {
  const tabs = '\t'.repeat(20_000);
  assert.equal(collapseWarningText(`first${tabs}last`), `first${tabs}last`);
  assert.equal(collapseWarningText(`first${tabs}\r\n${tabs}last`), 'first last');
  assert.equal(collapseWarningText('  first \t last  '), '  first \t last  ');
  assert.equal(collapseWarningText('first\n \n\tlast'), 'first last');
});

// `pinnedRefText` prints the ref pin for every partial CLI result. It spells the
// separator itself instead of calling the kernel owner, because this module sits in
// the CLI façade's eager module closure (see `output-common.ts`). These two tests
// make that freedom safe: the printed form must equal the owner's, and the owner's
// form must stay a plain literal word for the shells and command allow-rules that
// paste it.

test('pinnedRefText prints exactly the kernel owner form', () => {
  for (const [ref, generation] of [
    ['@e4', 434592],
    ['e4', 0],
    ['@e1001', 7],
  ] as const) {
    assert.equal(pinnedRefText(ref, generation), formatPinnedRef(ref, generation));
  }
  assert.equal(pinnedRefText('@e4', undefined), undefined);
  assert.equal(pinnedRefText('', 4), undefined);
});

test('a printed pin is a plain shell-literal word', () => {
  // Command allow-rule matchers parse the pasted command line before they apply an
  // allow rule, and they refuse an unquoted word holding a shell metacharacter. A
  // refused match runs the command sandboxed, where it cannot reach the daemon.
  const pin = pinnedRefText('@e4', 434592);
  assert.equal(pin, `@e4${REF_PIN_SEPARATOR}434592`);
  assert.match(pin, /^[A-Za-z0-9._:@/,+-]+$/);
  assert.notEqual(pin[0], '=');
});
