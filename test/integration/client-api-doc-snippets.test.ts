import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCmdSync } from '@agent-device/host-kit/command';

// Compiles every fenced ```ts snippet in website/docs/docs/client-api.md against
// agent-device's real `agent-device/*` subpath sources, so a doc snippet that no
// longer compiles — wrong property, renamed export, changed signature — fails
// CI instead of only being caught if an examples/sdk/*.ts file happens to drift
// the same way. src/__tests__/client-api-examples-drift.test.ts covers the
// doc's bullet-list API manifest against examples/sdk/*.ts; this is the
// complementary check the reviewer asked for on #1463's drift guard (checking
// the doc's actual code, not just its symbol-name manifest).
//
// Lives in the Node integration lane, not vitest's unit-core: it spawns a real
// tsc Program over a chunk of src/, which comfortably exceeds the unit suite's
// 2.5s slow-test budget (see docs/agents/testing.md).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIENT_API_DOC_PATH = path.join(repoRoot, 'website/docs/docs/client-api.md');
const EXAMPLES_SDK_TSCONFIG = path.join(repoRoot, 'examples/sdk/tsconfig.json');
const TSC_BIN = path.join(repoRoot, 'node_modules/.bin/tsc');

// Extracts every fenced ```ts code block from the doc, in document order. Each
// block is compiled standalone.
function extractTsSnippets(markdown: string): string[] {
  return [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
}

// examples/sdk/tsconfig.json's `paths` is the existing, CI-proven mechanism that
// resolves `agent-device/...` specifiers straight to `src/sdk/*.ts` so examples
// typecheck without a build (see that file's own comment). `tsc --showConfig`
// returns it fully resolved and comment-free, so this reads the one true copy of
// the subpath map instead of keeping a second, driftable one here.
function resolveExamplesSdkPaths(): Record<string, string[]> {
  const raw = runCmdSync(TSC_BIN, ['-p', EXAMPLES_SDK_TSCONFIG, '--showConfig']).stdout;
  const configDir = path.dirname(EXAMPLES_SDK_TSCONFIG);
  const paths: Record<string, string[]> = {};
  for (const [specifier, targets] of Object.entries(
    JSON.parse(raw).compilerOptions.paths as Record<string, string[]>,
  )) {
    paths[specifier] = targets.map((target) => path.resolve(configDir, target));
  }
  return paths;
}

// Free identifiers a snippet references without declaring, because the doc's
// prose treats them as continuing from an earlier snippet (`client`,
// `androidClient`, `snapshot` — typed against the real SDK return type, not
// `any`, so continuation snippets still get meaningful checking) or as
// illustrative host-glue the doc invents on purpose (a bridge's own transport
// function, never part of the SDK). This is a closed, explicit allowlist, not
// a catch-all: any free identifier NOT listed here — including a typo of one
// that IS, like `cliet` for `client` — is left as a real "Cannot find name"
// failure. See the "rejects an unrecognized free identifier" test below for
// the regression this guards against.
const KNOWN_FREE_NAME_STUB_TYPES: Record<string, string> = {
  client: `ReturnType<typeof import('agent-device').createAgentDeviceClient>`,
  androidClient: `ReturnType<typeof import('agent-device').createAgentDeviceClient>`,
  snapshot: `Awaited<ReturnType<ReturnType<typeof import('agent-device').createAgentDeviceClient>['capture']['snapshot']>>`,
  // "Android ADB providers": the doc's own invented remote-transport glue, not
  // part of agent-device — typed as the real `AndroidAdbExecutor` function
  // shape so the snippet's `exec: async (args, options) => ...` still has to
  // return something assignable to it.
  runAdbThroughRemoteTunnel: `import('agent-device/android-adb').AndroidAdbExecutor`,
  // "Batch orchestration for custom transports": the doc's own invented
  // command dispatcher and error mapper.
  dispatch: `(stepReq: unknown) => Promise<import('agent-device/contracts').DaemonResponseData>`,
  bridgeErrorToDaemonResponse: `(error: unknown) => import('agent-device/contracts').DaemonResponse`,
};

function writeSnippetProgram(snippets: string[]): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-api-doc-snippets-'));
  fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(
    path.join(tmpDir, 'tsconfig.json'),
    JSON.stringify({
      extends: path.join(repoRoot, 'tsconfig.json'),
      compilerOptions: {
        typeRoots: [path.join(repoRoot, 'node_modules/@types')],
        // Doc snippets are illustrative fragments, not production code: an
        // unused destructured result is normal and not a real defect here.
        noUnusedLocals: false,
        noUnusedParameters: false,
        paths: resolveExamplesSdkPaths(),
      },
      // src/global.d.ts declares build-time ambient globals (e.g. __OWNER_FILES__)
      // that src/ files reference; examples/sdk/tsconfig.json includes it for the
      // same reason.
      include: ['*.ts', path.join(repoRoot, 'src/global.d.ts')],
    }),
  );
  snippets.forEach((code, index) => {
    // `export {}` forces module scope so each snippet's declarations (and any
    // stubs injected below) can't collide with another snippet's globals.
    fs.writeFileSync(path.join(tmpDir, `snippet-${index}.ts`), `export {};\n${code}`);
  });
  return tmpDir;
}

function runTsc(tmpDir: string): string {
  const result = runCmdSync(
    TSC_BIN,
    ['--noEmit', '-p', path.join(tmpDir, 'tsconfig.json'), '--pretty', 'false'],
    { cwd: tmpDir, allowFailure: true },
  );
  return `${result.stdout}${result.stderr}`;
}

// Finds every "Cannot find name 'X'" diagnostic where `X` is in
// KNOWN_FREE_NAME_STUB_TYPES, grouped by snippet file. Any other free name —
// anything not in that explicit allowlist — is deliberately left out here, so
// its diagnostic survives untouched into the final output and fails the
// check. A missing/renamed *import* binding is a different diagnostic code
// and is never matched by this regex either way.
function findKnownFreeNamesByFile(tscOutput: string): Map<string, Set<string>> {
  const freeNamesByFile = new Map<string, Set<string>>();
  for (const line of tscOutput.split('\n')) {
    const match =
      /^(?:.*[/\\])?(snippet-\d+\.ts)\(\d+,\d+\): error TS2304: Cannot find name '([^']+)'/.exec(
        line,
      );
    const name = match?.[2];
    if (match?.[1] && name && name in KNOWN_FREE_NAME_STUB_TYPES) {
      const names = freeNamesByFile.get(match[1]) ?? new Set<string>();
      names.add(name);
      freeNamesByFile.set(match[1], names);
    }
  }
  return freeNamesByFile;
}

// One auto-stub pass: declare each known free name at the top of its snippet
// file (typed per KNOWN_FREE_NAME_STUB_TYPES) and recompile.
function stubFreeNamesAndRecompile(tmpDir: string, firstPassOutput: string): string {
  const freeNamesByFile = findKnownFreeNamesByFile(firstPassOutput);
  if (freeNamesByFile.size === 0) return firstPassOutput;

  for (const [fileName, names] of freeNamesByFile) {
    const filePath = path.join(tmpDir, fileName);
    const stubs = [...names]
      .map((name) => `declare const ${name}: ${KNOWN_FREE_NAME_STUB_TYPES[name]};`)
      .join('\n');
    fs.writeFileSync(
      filePath,
      fs.readFileSync(filePath, 'utf8').replace('export {};\n', `export {};\n${stubs}\n`),
    );
  }
  return runTsc(tmpDir);
}

function compileDocSnippets(snippets: string[]): string[] {
  const tmpDir = writeSnippetProgram(snippets);
  try {
    const output = stubFreeNamesAndRecompile(tmpDir, runTsc(tmpDir));
    return output.split('\n').filter((line) => /error TS\d+:/.test(line));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('recognizes known free names when TypeScript prints a relative snippet path', () => {
  const freeNames = findKnownFreeNamesByFile(
    "../../../../tmp/client-api-doc-snippets/snippet-3.ts(2,7): error TS2304: Cannot find name 'client'.",
  );
  assert.deepEqual([...(freeNames.get('snippet-3.ts') ?? [])], ['client']);
});

test("every fenced ```ts snippet in client-api.md compiles against agent-device's real exports", () => {
  const snippets = extractTsSnippets(fs.readFileSync(CLIENT_API_DOC_PATH, 'utf8'));
  assert.ok(
    snippets.length > 0,
    `${CLIENT_API_DOC_PATH} has no fenced \`\`\`ts snippets to check.`,
  );

  const failures = compileDocSnippets(snippets);
  assert.deepEqual(
    failures,
    [],
    `A \`\`\`ts snippet in ${CLIENT_API_DOC_PATH} no longer compiles against agent-device's real ` +
      `exports:\n${failures.join('\n')}\n` +
      'Fix the snippet to match the current API, or fix the actual exported contract if the doc ' +
      'was right and the API regressed.',
  );
});

test('rejects an unrecognized free identifier instead of silently stubbing it (e.g. a typo of `client`)', () => {
  const failures = compileDocSnippets([
    "import { createAgentDeviceClient } from 'agent-device';\n\n" +
      "const client = createAgentDeviceClient({ session: 'qa-ios' });\n" +
      "await cliet.apps.open({ app: 'com.example.app', platform: 'ios' });\n",
  ]);
  assert.ok(
    failures.some((line) => line.includes("Cannot find name 'cliet'")),
    `Expected a "Cannot find name 'cliet'" failure for an unrecognized free identifier, got: ` +
      `${JSON.stringify(failures)}. If this fails, stubFreeNamesAndRecompile is stubbing names ` +
      'outside its explicit allowlist again.',
  );
});
