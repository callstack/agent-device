import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPlatformPackagePolicy } from './platform-package-policy.ts';
import { declarations, policyOptions, validSources } from './platform-package-policy.fixtures.ts';

// The managed macOS leaf package (#4675): it holds a leaf of the bundled `apple` family, so R13
// polices its declaration and its imports apart from the family packages.

function messages(
  sources: ReadonlyMap<string, string>,
  packages = declarations(),
): readonly string[] {
  return checkPlatformPackagePolicy(sources, packages, policyOptions()).map(
    ({ message }) => message,
  );
}

test('the managed macOS leaf package is required and must declare the leaf it holds', () => {
  const withoutLeaf = declarations().filter(({ family }) => family !== 'macos');
  assert.match(
    messages(validSources(), withoutLeaf).join('\n'),
    /missing managed platform leaf package packages\/platform-macos/,
  );

  // A leaf package that claims the whole family is not the leaf it is declared to be.
  const familyClaim = declarations().map((declaration) =>
    declaration.family === 'macos'
      ? { ...declaration, managedClaim: { platform: 'apple', apiVersion: 3 } }
      : declaration,
  );
  assert.match(
    messages(validSources(), familyClaim).join('\n'),
    /Managed platform must declare its family leaf and export only @agent-device\/macos\/agent-device/,
  );
});

test('the macOS leaf package may not import the Apple owner it serves', () => {
  // The owner injects its runner and its tools; the leaf never reaches the owner's package.
  const file = 'packages/platform-macos/src/runner-commands.ts';
  const found = messages(
    new Map([
      ...validSources(),
      [file, "import { runAppleRunnerCommand } from '@agent-device/platform-apple';"],
    ]),
  ).join('\n');
  assert.match(found, /platform-macos may not import sibling '@agent-device\/platform-apple'/);
});
