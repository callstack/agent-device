import { createHash } from 'node:crypto';
import path from 'node:path';
import { snapshotSourceError } from './errors.ts';
import { SNAPSHOT_SOURCE_PROTOCOL_VERSION, SNAPSHOT_SOURCE_VERSION } from './protocol.ts';
import type {
  SnapshotSourceBridgeBinary,
  SnapshotSourceHost,
  SnapshotSourceLimits,
} from './types.ts';

type ToolchainIdentity = Readonly<{
  xcode: string;
  macos: string;
  architecture: 'arm64' | 'x86_64';
  simulatorSdk: string;
  simulatorRuntime: string;
}>;

type SnapshotBridgeCacheManifest = Readonly<{
  schemaVersion: 1;
  protocolVersion: number;
  sourceVersion: string;
  sourceHash: string;
  cacheKey: string;
  toolchain: ToolchainIdentity;
  binarySha256: string;
}>;

const CACHE_SCHEMA_VERSION = 1 as const;
const BRIDGE_FILENAME = 'snapshot-bridge';
const MANIFEST_FILENAME = 'manifest.json';
const SOURCE_FILENAMES = ['SnapshotBridge.m', 'SnapshotBridgeRuntime.m'] as const;
const BUILD_TIMEOUT_MS = 120_000;

export async function ensureSnapshotBridgeBinary(
  input: Readonly<{
    host: SnapshotSourceHost;
    runtime: string;
    limits: SnapshotSourceLimits;
    signal?: AbortSignal;
    sourceRoot?: string;
    cacheRoot?: string;
  }>,
): Promise<SnapshotSourceBridgeBinary> {
  const sourceRoot = input.sourceRoot ?? resolveSnapshotBridgeSourceRoot(input.host);
  const sourceHash = await fingerprintSource(input.host, sourceRoot);
  const toolchain = await readToolchainIdentity(input.host, input.runtime, input.signal);
  const cacheKey = hashJson({
    schemaVersion: CACHE_SCHEMA_VERSION,
    protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
    sourceVersion: SNAPSHOT_SOURCE_VERSION,
    sourceHash,
    toolchain,
    limits: {
      maxNodes: input.limits.maxNodes,
      maxTraversalDepth: input.limits.maxTraversalDepth,
    },
  });
  const cacheRoot =
    input.cacheRoot ?? path.join(input.host.homeDirectory(), '.agent-device', 'snapshot-source');
  const entryPath = path.join(cacheRoot, cacheKey);
  const releaseLock = await input.host.acquireLock(path.join(cacheRoot, `${cacheKey}.lock`));
  try {
    const cached = await readValidCache(input.host, entryPath, {
      sourceHash,
      cacheKey,
      toolchain,
    });
    if (cached) return cached;
    if (input.host.exists(entryPath)) await input.host.remove(entryPath);

    await input.host.ensureDirectory(cacheRoot);
    const temporaryPath = path.join(cacheRoot, `.${cacheKey}.${input.host.processId()}.tmp`);
    await input.host.remove(temporaryPath);
    try {
      await input.host.ensureDirectory(temporaryPath);
      const outputPath = path.join(temporaryPath, BRIDGE_FILENAME);
      const result = await input.host.run(
        'xcrun',
        [
          '--sdk',
          'iphonesimulator',
          'clang',
          '-arch',
          toolchain.architecture,
          '-mios-simulator-version-min=15.0',
          '-fobjc-arc',
          '-Werror',
          '-Wall',
          '-Wextra',
          '-framework',
          'Foundation',
          '-framework',
          'CoreGraphics',
          ...SOURCE_FILENAMES.map((sourceFile) => path.join(sourceRoot, sourceFile)),
          '-o',
          outputPath,
        ],
        { signal: input.signal, timeoutMs: BUILD_TIMEOUT_MS, allowFailure: true },
      );
      if (result.exitCode !== 0 || !input.host.exists(outputPath)) {
        throw snapshotSourceError('unsupported', 'native-build-failed', {
          exitCode: result.exitCode,
          stderr: result.stderr.slice(0, 4096),
        });
      }
      await input.host.chmod(outputPath, 0o755);
      const binarySha256 = await sha256File(input.host, outputPath);
      const manifest: SnapshotBridgeCacheManifest = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
        sourceVersion: SNAPSHOT_SOURCE_VERSION,
        sourceHash,
        cacheKey,
        toolchain,
        binarySha256,
      };
      await input.host.writeText(
        path.join(temporaryPath, MANIFEST_FILENAME),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      await input.host.rename(temporaryPath, entryPath);
      return {
        path: path.join(entryPath, BRIDGE_FILENAME),
        sourceHash,
        cacheKey,
        protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
        sourceVersion: SNAPSHOT_SOURCE_VERSION,
      };
    } catch (error) {
      await input.host.remove(temporaryPath);
      throw error;
    }
  } finally {
    await releaseLock();
  }
}

function resolveSnapshotBridgeSourceRoot(host: SnapshotSourceHost): string {
  const projectRoot = host.projectRoot();
  const checkoutRoot = path.join(projectRoot, 'apple', 'snapshot-bridge');
  if (host.exists(path.join(checkoutRoot, SOURCE_FILENAMES[0]))) return checkoutRoot;
  const packagedRoot = path.join(projectRoot, 'dist', 'apple', 'snapshot-bridge');
  if (host.exists(path.join(packagedRoot, SOURCE_FILENAMES[0]))) return packagedRoot;
  throw snapshotSourceError('unsupported', 'native-source-missing', { projectRoot });
}

// fallow-ignore-next-line complexity
async function readValidCache(
  host: SnapshotSourceHost,
  entryPath: string,
  expected: Readonly<{
    sourceHash: string;
    cacheKey: string;
    toolchain: ToolchainIdentity;
  }>,
): Promise<SnapshotSourceBridgeBinary | undefined> {
  const binaryPath = path.join(entryPath, BRIDGE_FILENAME);
  if (!host.exists(binaryPath) || !host.exists(path.join(entryPath, MANIFEST_FILENAME))) {
    return undefined;
  }
  try {
    const manifest = JSON.parse(
      await host.readText(path.join(entryPath, MANIFEST_FILENAME)),
    ) as Partial<SnapshotBridgeCacheManifest>;
    if (
      manifest.schemaVersion !== CACHE_SCHEMA_VERSION ||
      manifest.protocolVersion !== SNAPSHOT_SOURCE_PROTOCOL_VERSION ||
      manifest.sourceVersion !== SNAPSHOT_SOURCE_VERSION ||
      manifest.sourceHash !== expected.sourceHash ||
      manifest.cacheKey !== expected.cacheKey ||
      JSON.stringify(manifest.toolchain) !== JSON.stringify(expected.toolchain) ||
      typeof manifest.binarySha256 !== 'string'
    ) {
      return undefined;
    }
    if ((await sha256File(host, binaryPath)) !== manifest.binarySha256) return undefined;
    return {
      path: binaryPath,
      sourceHash: expected.sourceHash,
      cacheKey: expected.cacheKey,
      protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
      sourceVersion: SNAPSHOT_SOURCE_VERSION,
    };
  } catch {
    return undefined;
  }
}

async function fingerprintSource(host: SnapshotSourceHost, root: string): Promise<string> {
  const files = await sourceFiles(host, root);
  const hash = createHash('sha256');
  for (const filePath of files) {
    hash.update(path.relative(root, filePath));
    hash.update('\0');
    hash.update(await host.readBinary(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function sourceFiles(host: SnapshotSourceHost, root: string): Promise<string[]> {
  const entries = await host.listDirectory(root);
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(host, entryPath)));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files.sort();
}

async function readToolchainIdentity(
  host: SnapshotSourceHost,
  simulatorRuntime: string,
  signal: AbortSignal | undefined,
): Promise<ToolchainIdentity> {
  const [xcode, macos, architecture, simulatorSdk] = await Promise.all([
    toolOutput(host, 'xcodebuild', ['-version'], signal),
    toolOutput(host, 'sw_vers', ['-productVersion'], signal),
    toolOutput(host, 'uname', ['-m'], signal),
    toolOutput(host, 'xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'], signal),
  ]);
  const runtime = simulatorRuntime.trim();
  if (!runtime) throw snapshotSourceError('unsupported', 'simulator-runtime-missing');
  return {
    xcode,
    macos,
    architecture: simulatorArchitecture(architecture),
    simulatorSdk,
    simulatorRuntime: runtime,
  };
}

function simulatorArchitecture(value: string): 'arm64' | 'x86_64' {
  if (value === 'arm64' || value === 'x86_64') return value;
  throw snapshotSourceError('unsupported', 'simulator-architecture-unsupported', {
    architecture: value,
  });
}

async function toolOutput(
  host: SnapshotSourceHost,
  command: string,
  args: string[],
  signal: AbortSignal | undefined,
): Promise<string> {
  const result = await host.run(command, args, { allowFailure: true, signal, timeoutMs: 10_000 });
  if (result.exitCode !== 0) {
    throw snapshotSourceError('unsupported', 'toolchain-probe-failed', {
      command,
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 1024),
    });
  }
  const output = (result.stdout || result.stderr).trim();
  if (!output) throw snapshotSourceError('unsupported', 'toolchain-probe-empty', { command });
  return output;
}

async function sha256File(host: SnapshotSourceHost, filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await host.readBinary(filePath))
    .digest('hex');
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}
