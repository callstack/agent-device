import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const formScreenPath = path.join(repoRoot, 'examples/test-app/src/screens/FormScreen.tsx');

// #1874, `smoke:form-input` half: a `fill` whose value equals the target field's placeholder can
// never be confirmed. An empty text field renders its placeholder AS its accessibility value, so
// `element.value` is byte-identical whether the placeholder is showing or the committed text
// happens to match it — `awaitSynthesizedReplacementCommitOutcome` refuses such a wait outright
// (`textMatchesPlaceholder`), which is the documented contract, and the CLI reference says so.
//
// The fixture used to place `placeholder="Ada Lovelace"` on the field every suite fills with
// "Ada Lovelace". That is only reachable on the synthesized-replacement route, which is gated on
// `xCTestChannelPenalized` — i.e. it fires when the host is loaded — so it read as an intermittent
// simulator flake for months rather than as a fixture that asks for the one thing `fill` cannot
// verify. Frozen replay-compat corpora carry the same fill, so the collision has to be kept out of
// the placeholders rather than out of the values.

type Field = { testID: string; placeholder: string };

/** (testID, placeholder) pairs from the fixture's form screen, in source order. */
function fixtureFields(): Field[] {
  const source = fs.readFileSync(formScreenPath, 'utf8');
  const fields: Field[] = [];
  const blocks = source.split('<TextField').slice(1);
  for (const block of blocks) {
    const placeholder = /placeholder="([^"]*)"/.exec(block)?.[1];
    const testID = /testID="([^"]*)"/.exec(block)?.[1];
    if (placeholder !== undefined && testID !== undefined) fields.push({ testID, placeholder });
  }
  return fields;
}

/** Every `fill` in the repository's replay scripts and live runners, as (testID, value). */
function repositoryFills(): { source: string; testID: string; value: string }[] {
  const roots = ['examples/test-app/replays', 'test/integration', 'test/replay-compat'];
  const files: string[] = [];
  for (const root of roots) {
    const dir = path.join(repoRoot, root);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      if (/\.(ad|ts)$/.test(entry)) files.push(path.join(dir, entry));
    }
  }
  const fills: { source: string; testID: string; value: string }[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    // `fill id="field-name" "Ada Lovelace"` (.ad) and `['fill', 'id="field-name"', 'Ada Lovelace']`
    const patterns = [/fill\s+id="([^"]+)"\s+"([^"]*)"/g, /'fill',\s*'id="([^"]+)"',\s*'([^']*)'/g];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        fills.push({ source: path.relative(repoRoot, file), testID: match[1]!, value: match[2]! });
      }
    }
  }
  return fills;
}

test('no fixture fill asks for a value the field renders as its own placeholder', () => {
  const fields = fixtureFields();
  assert.ok(fields.length > 0, 'the form fixture must expose placeheld text fields to check');

  const placeholderByTestID = new Map(fields.map((field) => [field.testID, field.placeholder]));
  const collisions = repositoryFills()
    .filter(({ testID, value }) => {
      const placeholder = placeholderByTestID.get(testID);
      // Mirrors RunnerTests+TextEntry.swift `textMatchesPlaceholder`: trimmed, whole-value equality.
      return (
        placeholder !== undefined && placeholder.trim() === value.trim() && value.trim() !== ''
      );
    })
    .map(({ source, testID, value }) => `${source}: fill id="${testID}" "${value}"`);

  assert.deepEqual(
    collisions,
    [],
    'change the fixture placeholder, not the filled value — frozen replay-compat corpora carry these fills',
  );
});
