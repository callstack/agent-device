import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  const raw = execFileSync(TSC_BIN, ['-p', EXAMPLES_SDK_TSCONFIG, '--showConfig'], {
    encoding: 'utf8',
  });
  const configDir = path.dirname(EXAMPLES_SDK_TSCONFIG);
  const paths: Record<string, string[]> = {};
  for (const [specifier, targets] of Object.entries(
    JSON.parse(raw).compilerOptions.paths as Record<string, string[]>,
  )) {
    paths[specifier] = targets.map((target) => path.resolve(configDir, target));
  }
  return paths;
}

// Free identifiers a snippet references without declaring — continuing a
// `client`/`snapshot` from an earlier snippet in the doc's prose. Typed against
// the real SDK return types (not `any`) so continuation snippets still get
// meaningful checking; anything else (illustrative host-glue names the doc
// invents, like a bridge's own transport function) falls back to `any`, which
// only weakens the check for that invented name, not for the real SDK calls
// around it.
const KNOWN_CONTINUATION_STUB_TYPES: Record<string, string> = {
  client: `ReturnType<typeof import('agent-device').createAgentDeviceClient>`,
  androidClient: `ReturnType<typeof import('agent-device').createAgentDeviceClient>`,
  snapshot: `Awaited<ReturnType<ReturnType<typeof import('agent-device').createAgentDeviceClient>['capture']['snapshot']>>`,
};

// Pre-existing gaps this check surfaced that are out of scope for #1463 to fix
// (they predate this PR and touch unrelated public API surface, not the new
// examples): flagged for the maintainer rather than silently patched. Remove
// an entry once the underlying gap is closed.
const KNOWN_DOC_GAPS = [
  // "Remote Metro helpers": prepareRemoteMetro/reloadRemoteMetro/stopMetroTunnel
  // aren't exported from `agent-device/metro`, and resolveRemoteConfigProfile
  // isn't exported from `agent-device/remote-config` — the doc documents a
  // public surface neither subpath's src/sdk/*.ts re-exports today.
  `Module '"agent-device/metro"' has no exported member 'prepareRemoteMetro'`,
  `Module '"agent-device/metro"' has no exported member 'reloadRemoteMetro'`,
  `Module '"agent-device/metro"' has no exported member 'stopMetroTunnel'`,
  `'"agent-device/remote-config"' has no exported member named 'resolveRemoteConfigProfile'`,
  // "Web sessions" / audio probe: NetworkOptions/AudioOptions have no `platform`
  // field, even though the CLI's `network`/`audio` commands accept `--platform`
  // — the typed client's contracts are narrower than the CLI surface here.
  `'platform' does not exist in type 'NetworkOptions'`,
  `'platform' does not exist in type 'AudioOptions'`,
];

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
  try {
    execFileSync(
      TSC_BIN,
      ['--noEmit', '-p', path.join(tmpDir, 'tsconfig.json'), '--pretty', 'false'],
      {
        encoding: 'utf8',
        cwd: tmpDir,
      },
    );
    return '';
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    return `${stdout ?? ''}${stderr ?? ''}`;
  }
}

// One auto-stub pass: for every "Cannot find name 'X'" diagnostic, declare `X`
// (typed precisely if it's a known SDK-derived continuation, `any` otherwise)
// at the top of that snippet file and recompile. A missing/renamed *import*
// binding is a different diagnostic code and is never suppressed this way.
function stubFreeNamesAndRecompile(tmpDir: string, firstPassOutput: string): string {
  const freeNamesByFile = new Map<string, Set<string>>();
  for (const line of firstPassOutput.split('\n')) {
    const match = /^(snippet-\d+\.ts)\(\d+,\d+\): error TS2304: Cannot find name '([^']+)'/.exec(
      line,
    );
    if (match?.[1] && match[2]) {
      const names = freeNamesByFile.get(match[1]) ?? new Set<string>();
      names.add(match[2]);
      freeNamesByFile.set(match[1], names);
    }
  }
  if (freeNamesByFile.size === 0) return firstPassOutput;

  for (const [fileName, names] of freeNamesByFile) {
    const filePath = path.join(tmpDir, fileName);
    const stubs = [...names]
      .map((name) => `declare const ${name}: ${KNOWN_CONTINUATION_STUB_TYPES[name] ?? 'any'};`)
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
    const diagnosticLines = output.split('\n').filter((line) => /error TS\d+:/.test(line));
    return diagnosticLines.filter((line) => !KNOWN_DOC_GAPS.some((gap) => line.includes(gap)));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

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
      'Fix the snippet to match the current API, or update the SDK if the doc was right and the ' +
      'API regressed. If this is a new, deliberately out-of-scope gap, add it to KNOWN_DOC_GAPS ' +
      'with a comment explaining why.',
  );
});
