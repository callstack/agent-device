import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import test from 'node:test';

// The test-app workspace overrides zod@3 and zod@4 to >= 4.6.6 to clear
// GHSA-mrhx-c7xc-m3w5. @expo/cli declares zod ^3.25.76 yet is the only
// zod@3 consumer in this tree, so the override runs it on zod 4. These tests
// prove the claim: every schema @expo/cli builds with zod must load and
// validate under the resolved zod, and the resolved version must stay at or
// above the patched floor.

const requireFromTestApp = createRequire(new URL('../package.json', import.meta.url));
const expoDir = requireFromTestApp.resolve('expo/package.json');
const cliRequire = createRequire(createRequire(expoDir).resolve('@expo/cli/package.json'));
// @expo/cli is the zod@3 consumer the override moves, so its resolved zod is
// the copy that runs during `expo start`.
const zodVersion = cliRequire('zod/package.json').version;
const lockfile = fs.readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');

// The advisory's patched floor. A regression below it reopens the alert.
const PATCHED_ZOD_MAJOR_MINOR = [4, 6];
const [major, minor] = zodVersion.split('.').map(Number);
assert.ok(
  major > PATCHED_ZOD_MAJOR_MINOR[0] ||
    (major === PATCHED_ZOD_MAJOR_MINOR[0] && minor >= PATCHED_ZOD_MAJOR_MINOR[1]),
  `zod must resolve at or above 4.6.6, got ${zodVersion}`,
);

function cliBuild(subpath) {
  // Load the bundled module the same way the dev server does, so the @expo/cli
  // copy that expo mounts is the copy under test.
  return cliRequire(`./build/${subpath}`);
}

test('the lockfile pins exactly one zod resolution and no vulnerable major', () => {
  const resolutions = [...lockfile.matchAll(/^ {2}zod@(\d+\.\d+\.\d+):/gm)].map((m) => m[1]);
  assert.equal(resolutions.length > 0, true, 'the lockfile must resolve zod');
  assert.equal(new Set(resolutions).size, 1, `expected one zod resolution, got ${resolutions}`);
  assert.equal(resolutions[0], zodVersion, 'the installed zod must match the lock resolution');
  for (const version of resolutions) {
    assert.equal(
      version.startsWith('3.'),
      false,
      `zod ${version} is below the 4.6.6 advisory floor`,
    );
  }
});

test('@expo/cli loads the overridden zod despite declaring a ^3 range', () => {
  const declared = cliRequire('./package.json').dependencies.zod;
  assert.match(declared, /^\^3\./, `@expo/cli is expected to declare zod ^3, got ${declared}`);
  assert.ok(
    !zodVersion.startsWith('3.'),
    `the override must move @expo/cli off zod 3, resolved ${zodVersion}`,
  );
});

test('@expo/cli plugin schemas validate and reject under the overridden zod', () => {
  const { PluginSchema, DevToolsPluginOutputSchema } = cliBuild(
    'src/start/server/DevToolsPlugin.schema.js',
  );

  const validPlugin = {
    packageName: '@acme/devtools',
    packageRoot: '/plugins/acme',
    cliExtensions: {
      description: 'Acme controls',
      entryPoint: 'cli.js',
      commands: [
        {
          name: 'ping',
          title: 'Ping',
          environments: ['cli'],
          parameters: [{ name: 'target', type: 'text', description: 'Host to ping' }],
        },
      ],
    },
  };
  const plugin = PluginSchema.safeParse(validPlugin);
  assert.equal(plugin.success, true, `valid plugin must parse: ${plugin.error?.message}`);

  // The callers print `result.error.issues.map((issue) => issue.message)`.
  // zod 4 must keep that surface.
  const invalid = PluginSchema.safeParse({ packageRoot: 7 });
  assert.equal(invalid.success, false, 'a plugin without packageName must be rejected');
  assert.ok(Array.isArray(invalid.error.issues), 'error.issues must be an array');
  assert.equal(typeof invalid.error.message, 'string', 'error.message must be a string');
  assert.equal(
    typeof invalid.error.issues.map((issue) => issue.message).join(', '),
    'string',
    'callers format issues via .message',
  );

  const validOutput = [
    { type: 'text', text: 'done', level: 'info' },
    { type: 'image', url: 'https://example.test/a.png' },
  ];
  const output = DevToolsPluginOutputSchema.safeParse(validOutput);
  assert.equal(output.success, true, `valid output must parse: ${output.error?.message}`);

  const badOutput = DevToolsPluginOutputSchema.safeParse([
    { type: 'audio', url: 'not-a-url' },
    { type: 'unknown-kind' },
  ]);
  assert.equal(badOutput.success, false, 'malformed output must be rejected');
  assert.ok(badOutput.error.issues.length > 0, 'rejection must carry issues for the caller');
});

test('@expo/cli builds a strict MCP command schema under the overridden zod', () => {
  const { createMCPDevToolsExtensionSchema } = cliBuild(
    'src/start/server/createMCPDevToolsExtensionSchema.js',
  );
  const schema = createMCPDevToolsExtensionSchema({
    packageName: '@acme/devtools',
    cliExtensions: {
      commands: [
        {
          name: 'ping',
          title: 'Ping',
          parameters: [
            { name: 'count', type: 'number' },
            { name: 'force', type: 'confirm' },
          ],
        },
      ],
    },
  });

  const good = schema.safeParse({ command: 'ping', count: 3, force: true });
  assert.equal(good.success, true, `valid command must parse: ${good.error?.message}`);
  assert.equal(
    schema.safeParse({ command: 'nope' }).success,
    false,
    'an unknown command must be rejected by the enum',
  );
  assert.equal(
    schema.safeParse({ command: 'ping', extra: 1 }).success,
    false,
    '.strict() must reject unknown parameters',
  );
  assert.equal(
    schema.safeParse({ command: 'ping', count: 'three' }).success,
    false,
    'a mistyped parameter must be rejected',
  );
});
