// R12 bin-alias-fast-path, tested directly: what each pure function reports for a fixture,
// independently of the check.ts wiring that turns it into a violation.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  ALIAS_REGISTRY_FILE,
  aliasResolverLocalName,
  BIN_FILE,
  importsAliasResolver,
  localAliasLiterals,
  registryAliasTokens,
  usageTextCallsResolver,
} from './bin-alias-fast-path.ts';

const REGISTRY_FIXTURE = `
import type { CliFlags } from '@agent-device/contracts/command';
const CLI_COMMAND_ALIASES = [
  { alias: 'long-press', command: 'longpress' },
  { alias: 'metrics', command: 'perf' },
  { alias: 'tap', command: 'press' },
  { alias: 'launch', command: 'open' },
  { alias: 'relaunch', command: 'open', impliedFlags: ['relaunch'] },
];
export function normalizeCliCommandAlias(command) { return command; }
`;

test('registryAliasTokens reads every alias property value out of the registry source', () => {
  assert.deepEqual(registryAliasTokens(REGISTRY_FIXTURE), [
    'launch',
    'long-press',
    'metrics',
    'relaunch',
    'tap',
  ]);
});

test('registryAliasTokens is not fooled by an unrelated `alias` string elsewhere in the file', () => {
  // Only a `{ alias: '<token>' }` object-property VALUE counts. A same-named local variable, or
  // the word appearing inside a comment, must not contribute a token.
  const source = "const alias = 'not-a-token';\n// alias: also not a token\n";
  assert.deepEqual(registryAliasTokens(source), []);
});

test('importsAliasResolver is true only for a real VALUE import of the resolver', () => {
  assert.equal(
    importsAliasResolver(
      "import { normalizeCliCommandAlias } from './commands/cli-command-aliases.ts';\n",
    ),
    true,
  );
  // A renamed local binding still delegates to the real function — the registry specifier and
  // the imported name are what matter, not what the caller calls it locally.
  assert.equal(
    importsAliasResolver(
      "import { normalizeCliCommandAlias as resolve } from './commands/cli-command-aliases.ts';\n",
    ),
    true,
  );
});

test('importsAliasResolver is false for a type-only import', () => {
  // Erased at compile time — no runtime delegation at all, which is exactly the STOP condition
  // the original plan called out: importing the registry as a type only would look wired
  // without actually being wired.
  assert.equal(
    importsAliasResolver(
      "import type { normalizeCliCommandAlias } from './commands/cli-command-aliases.ts';\n",
    ),
    false,
  );
});

test('importsAliasResolver is false when the import is missing or from the wrong module', () => {
  assert.equal(importsAliasResolver('const x = 1;\n'), false);
  assert.equal(
    importsAliasResolver("import { normalizeCliCommandAlias } from './wrong-file.ts';\n"),
    false,
  );
  assert.equal(
    importsAliasResolver("import { somethingElse } from './commands/cli-command-aliases.ts';\n"),
    false,
  );
});

test('aliasResolverLocalName resolves the LOCAL binding, following an `as` alias', () => {
  assert.equal(
    aliasResolverLocalName(
      "import { normalizeCliCommandAlias } from './commands/cli-command-aliases.ts';\n",
    ),
    'normalizeCliCommandAlias',
  );
  assert.equal(
    aliasResolverLocalName(
      "import { normalizeCliCommandAlias as resolveAlias } from './commands/cli-command-aliases.ts';\n",
    ),
    'resolveAlias',
  );
});

test('aliasResolverLocalName is null when there is no matching value import', () => {
  assert.equal(aliasResolverLocalName('const x = 1;\n'), null);
  assert.equal(
    aliasResolverLocalName(
      "import type { normalizeCliCommandAlias } from './commands/cli-command-aliases.ts';\n",
    ),
    null,
  );
});

test('usageTextCallsResolver is true for the real composition, by local name', () => {
  assert.equal(
    usageTextCallsResolver(
      'const commandHelp = buildCommandUsageText(normalizeCliCommandAlias(helpTarget));\n',
      'normalizeCliCommandAlias',
    ),
    true,
  );
  // Binds by whatever LOCAL name the caller passes — an aliased import's local name must still
  // be found at the call site, since that is the only name available to call it by.
  assert.equal(
    usageTextCallsResolver(
      'const commandHelp = buildCommandUsageText(resolveAlias(helpTarget));\n',
      'resolveAlias',
    ),
    true,
  );
});

test('usageTextCallsResolver is false for a raw call, with no wrapping resolver call', () => {
  assert.equal(
    usageTextCallsResolver(
      'const commandHelp = buildCommandUsageText(helpTarget);\n',
      'normalizeCliCommandAlias',
    ),
    false,
  );
});

// #P2 (maintainer review of the original R12): import presence and literal absence both still
// pass a bin.ts that imports the resolver and never calls it, or calls it on something unrelated,
// while buildCommandUsageText runs on the raw, unresolved helpTarget. These two fixtures are
// exactly that regression — the import is real and even "used", but never as the argument
// buildCommandUsageText receives — and usageTextCallsResolver must reject both.
test('usageTextCallsResolver rejects a present-but-unused import', () => {
  const source = `
import { normalizeCliCommandAlias } from './commands/cli-command-aliases.ts';
const commandHelp = buildCommandUsageText(helpTarget);
`;
  assert.equal(importsAliasResolver(source), true);
  assert.equal(usageTextCallsResolver(source, aliasResolverLocalName(source)!), false);
});

test('usageTextCallsResolver rejects an import used only unrelated to buildCommandUsageText', () => {
  const source = `
import { normalizeCliCommandAlias } from './commands/cli-command-aliases.ts';
void normalizeCliCommandAlias;
const commandHelp = buildCommandUsageText(helpTarget);
`;
  assert.equal(importsAliasResolver(source), true);
  assert.equal(usageTextCallsResolver(source, aliasResolverLocalName(source)!), false);
});

test('localAliasLiterals reports every requested token present as a string literal', () => {
  // The pre-fix bin.ts shape: a hand-written table re-declaring two of the five tokens.
  const preFixBinSource = `
function normalizeHelpTarget(command) {
  if (command === 'long-press') return 'longpress';
  if (command === 'metrics') return 'perf';
  return command;
}
`;
  assert.deepEqual(
    localAliasLiterals(preFixBinSource, ['long-press', 'metrics', 'tap', 'launch', 'relaunch']),
    ['long-press', 'metrics'],
  );
});

test('localAliasLiterals ignores tokens that only appear as identifiers, not string literals', () => {
  const source = 'const tap = 1;\nfunction launch() {}\n';
  assert.deepEqual(localAliasLiterals(source, ['tap', 'launch']), []);
});

test('localAliasLiterals reports nothing when the fixed bin.ts delegates and holds no literals', () => {
  const fixedBinSource = `
import { normalizeCliCommandAlias } from './commands/cli-command-aliases.ts';
const commandHelp = buildCommandUsageText(normalizeCliCommandAlias(helpTarget));
`;
  assert.deepEqual(
    localAliasLiterals(fixedBinSource, ['long-press', 'metrics', 'tap', 'launch', 'relaunch']),
    [],
  );
});

const repoRoot = path.resolve(import.meta.dirname, '../..');

test('the real tree imports the resolver, calls it into buildCommandUsageText, holds no local alias literals, and passes R12', () => {
  const registrySource = readFileSync(path.join(repoRoot, ALIAS_REGISTRY_FILE), 'utf8');
  const binSource = readFileSync(path.join(repoRoot, BIN_FILE), 'utf8');
  const tokens = registryAliasTokens(registrySource);
  assert.deepEqual(tokens, ['launch', 'long-press', 'metrics', 'relaunch', 'tap']);
  const localName = aliasResolverLocalName(binSource);
  assert.equal(localName, 'normalizeCliCommandAlias');
  assert.equal(usageTextCallsResolver(binSource, localName!), true);
  assert.deepEqual(localAliasLiterals(binSource, tokens), []);
});
