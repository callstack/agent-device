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
  countLocalBindings,
  helpTargetBindingName,
  importsAliasResolver,
  localAliasLiterals,
  registryAliasTokens,
  usageTextDelegationFailure,
} from './bin-alias-fast-path.ts';

/**
 * The shape of bin.ts's real `--help` fast path, minus everything R12 does not read. Fixtures
 * below vary one thing against this baseline, so a test's subject is the line it changed.
 */
function binFixture(fastPathBody: string, prelude = ''): string {
  return `
import { normalizeCliCommandAlias } from './commands/cli-command-aliases.ts';
${prelude}
function runHelpFastPath(argv) {
  const helpTarget = resolveSimpleHelpTarget(argv);
  if (helpTarget === undefined) return false;
${fastPathBody}
  return true;
}
`;
}

/** `usageTextDelegationFailure` for a fixture, resolving the local name the way check.ts does. */
function delegationFailure(source: string): string | null {
  return usageTextDelegationFailure(source, aliasResolverLocalName(source)!);
}

const REGISTRY_FIXTURE = `
import type { CliFlags } from '@agent-device/contracts/command';
const CLI_COMMAND_ALIASES = [
  { alias: 'long-press', command: 'longpress' },
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

test('helpTargetBindingName reads the binding resolveSimpleHelpTarget produces', () => {
  assert.equal(
    helpTargetBindingName(binFixture('  buildCommandUsageText(normalizeCliCommandAlias(x));')),
    'helpTarget',
  );
  // Renaming the local re-points the guard rather than disarming it — the name is never assumed.
  const renamed = `
function runHelpFastPath(argv) {
  const target = resolveSimpleHelpTarget(argv);
}
`;
  assert.equal(helpTargetBindingName(renamed), 'target');
});

test('helpTargetBindingName is null when the fast path no longer produces one', () => {
  assert.equal(helpTargetBindingName('const helpTarget = argv[0];\n'), null);
});

test('countLocalBindings counts value declarations only, not the import or type positions', () => {
  const source = `
import { normalizeCliCommandAlias } from './commands/cli-command-aliases.ts';
function f(helpTarget: normalizeCliCommandAlias) { const other = 1; }
`;
  // The import itself is not a shadow, and a type annotation naming the resolver binds nothing.
  assert.equal(countLocalBindings(source, 'normalizeCliCommandAlias'), 0);
  assert.equal(countLocalBindings(source, 'helpTarget'), 1);
  assert.equal(countLocalBindings('const x = 1;\nfunction x() {}\n', 'x'), 2);
});

test('usageTextDelegationFailure accepts the real composition, by local name', () => {
  assert.equal(
    delegationFailure(
      binFixture(
        '  const commandHelp = buildCommandUsageText(normalizeCliCommandAlias(helpTarget));',
      ),
    ),
    null,
  );
  // Binds by whatever LOCAL name the import resolved to — an aliased import's local name must
  // still be found at the call site, since that is the only name available to call it by.
  const aliased = `
import { normalizeCliCommandAlias as resolveAlias } from './commands/cli-command-aliases.ts';
function runHelpFastPath(argv) {
  const helpTarget = resolveSimpleHelpTarget(argv);
  const commandHelp = buildCommandUsageText(resolveAlias(helpTarget));
}
`;
  assert.equal(delegationFailure(aliased), null);
});

test('usageTextDelegationFailure rejects a raw call, with no wrapping resolver call', () => {
  const failure = delegationFailure(
    binFixture('  const commandHelp = buildCommandUsageText(helpTarget);'),
  );
  assert.match(failure ?? '', /buildCommandUsageText\(helpTarget\)/);
});

// #P2 (first maintainer review of R12): import presence and literal absence both still pass a
// bin.ts that imports the resolver and never calls it, or calls it on something unrelated, while
// buildCommandUsageText runs on the raw, unresolved helpTarget.
test('usageTextDelegationFailure rejects a present-but-unused import', () => {
  const source = binFixture('  const commandHelp = buildCommandUsageText(helpTarget);');
  assert.equal(importsAliasResolver(source), true);
  assert.notEqual(delegationFailure(source), null);
});

test('usageTextDelegationFailure rejects an import used only unrelated to buildCommandUsageText', () => {
  const source = binFixture(
    '  const commandHelp = buildCommandUsageText(helpTarget);',
    'void normalizeCliCommandAlias;',
  );
  assert.equal(importsAliasResolver(source), true);
  assert.notEqual(delegationFailure(source), null);
});

// #P2 (second maintainer review of R12): the fixture below is the reviewer's own, verbatim in
// shape. An EXISTENTIAL fact 3 — "some buildCommandUsageText call somewhere wraps the resolver" —
// accepts it, because the decoy on the first line satisfies the quantifier while the line that
// actually ships resolves nothing. This is the regression that motivated making fact 3 universal
// and value-bound, and it must be rejected for BOTH reasons independently.
test('usageTextDelegationFailure rejects a decoy wrapped call beside a raw shipped call', () => {
  const source = binFixture(
    `  void buildCommandUsageText(normalizeCliCommandAlias('open'));
  const commandHelp = buildCommandUsageText(helpTarget);`,
  );
  assert.equal(importsAliasResolver(source), true);
  const failure = delegationFailure(source);
  assert.match(failure ?? '', /every buildCommandUsageText call must receive/);
});

test('usageTextDelegationFailure rejects the resolver applied to anything but the help target', () => {
  // The decoy alone, with no raw call at all: the only usage-text call in the file wraps the
  // resolver, so a universal-but-not-value-bound fact 3 would still pass it.
  const source = binFixture(
    "  const commandHelp = buildCommandUsageText(normalizeCliCommandAlias('open'));",
  );
  assert.match(delegationFailure(source) ?? '', /normalizeCliCommandAlias\("open"\)/);
});

test('usageTextDelegationFailure rejects a local shadow of the imported resolver', () => {
  // Fact 3 binds by NAME, so a same-named local would otherwise let the composition read as
  // delegation while calling something that resolves nothing.
  const source = binFixture(
    '  const commandHelp = buildCommandUsageText(normalizeCliCommandAlias(helpTarget));',
    'const normalizeCliCommandAlias = (command) => command;',
  );
  assert.match(delegationFailure(source) ?? '', /shadowing the imported resolver/);
});

test('usageTextDelegationFailure rejects an ambiguous second help-target binding', () => {
  const source = binFixture(
    `  const helpTarget = 'open';
  const commandHelp = buildCommandUsageText(normalizeCliCommandAlias(helpTarget));`,
  );
  assert.match(delegationFailure(source) ?? '', /declares helpTarget more than once/);
});

test('usageTextDelegationFailure reports a fast path that no longer builds usage text at all', () => {
  const gone = `
import { normalizeCliCommandAlias } from './commands/cli-command-aliases.ts';
function runHelpFastPath(argv) {
  const helpTarget = resolveSimpleHelpTarget(argv);
  void normalizeCliCommandAlias(helpTarget);
}
`;
  assert.match(delegationFailure(gone) ?? '', /never calls buildCommandUsageText/);
  // …and one whose help-target producer is gone, so the guard says so instead of passing blind.
  const untraceable = `
import { normalizeCliCommandAlias } from './commands/cli-command-aliases.ts';
const commandHelp = buildCommandUsageText(normalizeCliCommandAlias(argv[1]));
`;
  assert.match(delegationFailure(untraceable) ?? '', /has no variable initialized by/);
});

test('localAliasLiterals reports every requested token present as a string literal', () => {
  // A stale bin.ts shape with a hand-written alias table.
  const preFixBinSource = `
function normalizeHelpTarget(command) {
  if (command === 'long-press') return 'longpress';
  return command;
}
`;
  assert.deepEqual(
    localAliasLiterals(preFixBinSource, ['long-press', 'tap', 'launch', 'relaunch']),
    ['long-press'],
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
    localAliasLiterals(fixedBinSource, ['long-press', 'tap', 'launch', 'relaunch']),
    [],
  );
});

const repoRoot = path.resolve(import.meta.dirname, '../..');

test('the real tree imports the resolver, calls it into buildCommandUsageText, holds no local alias literals, and passes R12', () => {
  const registrySource = readFileSync(path.join(repoRoot, ALIAS_REGISTRY_FILE), 'utf8');
  const binSource = readFileSync(path.join(repoRoot, BIN_FILE), 'utf8');
  const tokens = registryAliasTokens(registrySource);
  assert.deepEqual(tokens, ['launch', 'long-press', 'relaunch', 'tap']);
  const localName = aliasResolverLocalName(binSource);
  assert.equal(localName, 'normalizeCliCommandAlias');
  assert.equal(helpTargetBindingName(binSource), 'helpTarget');
  assert.equal(usageTextDelegationFailure(binSource, localName!), null);
  assert.deepEqual(localAliasLiterals(binSource, tokens), []);
});
