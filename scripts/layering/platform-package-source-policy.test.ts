import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPlatformPackageSourcePolicy } from './platform-package-source-policy.ts';

const facadeFile = 'packages/platform-apple/src/index.ts';
const mechanicsFile = 'packages/platform-apple/src/mechanics.ts';

function messages(source: string, file = mechanicsFile): string {
  return checkPlatformPackageSourcePolicy(file, source, 'apple')
    .map(({ message }) => message)
    .join('\n');
}

test('facade dynamic imports must be nested in deferred functions', () => {
  assert.match(
    messages("const eagerMechanics = import('./implementation.ts');", facadeFile),
    /dynamic import.*must be nested in a deferred function/,
  );
});

test('platform production cannot acquire ambient filesystem, OS, process, or network authority', () => {
  for (const statement of [
    "import { readFile } from 'node:fs/promises';",
    "import { homedir } from 'node:os';",
    "import process from 'node:process';",
    'const sdk = process.env.ANDROID_HOME;',
    "export async function request() { return await fetch('https://example.test'); }",
  ]) {
    assert.match(messages(statement), /ambient host authority/, statement);
  }
});

test('platform facades cannot probe injected host capabilities at module evaluation', () => {
  assert.match(
    messages("const appleTool = host.commands.which('apple-tool');", facadeFile),
    /may not probe the host at module evaluation/,
  );
});

test('syntax checks ignore comments and strings and allow deferred imports and host use', () => {
  const source = [
    "const documentation = \"process.env.HOME; fetch('https://example.test'); import('./eager.ts')\";",
    "// host.commands.which('apple-tool');",
    'export async function loadInventory(host: Host) {',
    "  const mechanics = await import('./implementation.ts');",
    "  const executable = await host.commands.which('apple-tool');",
    '  return { mechanics, executable, documentation };',
    '}',
  ].join('\n');
  assert.deepEqual(checkPlatformPackageSourcePolicy(facadeFile, source, 'apple'), []);
});
