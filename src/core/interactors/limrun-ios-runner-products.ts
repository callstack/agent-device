import { limrunRunnerError } from './limrun-ios-runner-errors.ts';
import {
  runnerListenerEnv,
  RUNNER_XCTESTRUN_CAPTURE_OPTIONS,
} from '@agent-device/platform-apple/runner/operations';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { extractArchiveSafely } from '@agent-device/host-kit/archive';
import { escapeXmlTextAndAttribute } from '@agent-device/xml';
import { downloadLimrunFile } from '../limrun-download-file.ts';

/** Stages the version-matched release runner, or an explicitly supplied development build. */
export async function prepareLimrunRunnerProducts(input: {
  directory: string;
  version: string;
  appPath?: string;
  bindAddress: string;
  endpoint: { port: number; token: string };
  signal: AbortSignal;
}): Promise<string> {
  if (isIP(input.bindAddress) !== 4 || input.bindAddress === '0.0.0.0') {
    throw limrunRunnerError(
      'limrun_runner_products_invalid',
      'Limrun USE_IP must be a concrete IPv4 address',
    );
  }
  const products = path.join(input.directory, `runner-${randomUUID()}`);
  await fs.mkdir(products);
  let appPath = input.appPath;
  if (!appPath) {
    if (!/^\d+\.\d+\.\d+$/.test(input.version)) {
      throw limrunRunnerError(
        'limrun_runner_products_invalid',
        'Nightly and development builds require AGENT_DEVICE_LIMRUN_IOS_RUNNER_APP',
        {
          hint: 'Point it at the simulator runner .app built from this agent-device checkout.',
        },
        'INVALID_ARGS',
      );
    }
    const name = `agent-device-ios-runner-${input.version}`;
    const release = `https://github.com/callstack/agent-device/releases/download/v${input.version}`;
    const manifestPath = path.join(input.directory, 'manifest.json');
    await downloadLimrunFile({
      url: `${release}/${name}.manifest.json`,
      headers: {},
      destinationPath: manifestPath,
      timeoutMs: 120_000,
      signal: input.signal,
    });
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    if (
      manifest.version !== input.version ||
      manifest.platform_target !== 'iphonesimulator' ||
      typeof manifest.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256)
    ) {
      throw limrunRunnerError(
        'limrun_runner_products_invalid',
        'Invalid iOS runner release manifest',
      );
    }
    const archivePath = path.join(input.directory, 'runner.tar.gz');
    await downloadLimrunFile({
      url: `${release}/${name}.app.tar.gz`,
      headers: {},
      destinationPath: archivePath,
      timeoutMs: 120_000,
      signal: input.signal,
    });
    input.signal.throwIfAborted();
    const digest = createHash('sha256')
      .update(await fs.readFile(archivePath, { signal: input.signal }))
      .digest('hex');
    if (digest !== manifest.sha256)
      throw limrunRunnerError('limrun_runner_products_invalid', 'iOS runner checksum mismatch');
    const extracted = path.join(input.directory, 'extracted');
    await extractArchiveSafely({
      archivePath,
      outputRoot: extracted,
      type: 'tgz',
      signal: input.signal,
    });
    appPath = path.join(extracted, `${name}.app`);
  }
  input.signal.throwIfAborted();
  if (
    !appPath.endsWith('.app') ||
    !(
      await fs.stat(appPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
        throw error;
      })
    )?.isDirectory()
  ) {
    throw limrunRunnerError(
      'limrun_runner_products_invalid',
      'The Limrun XCTest runner must be an iOS simulator .app',
      {},
      'INVALID_ARGS',
    );
  }
  const plugins = await fs
    .readdir(path.join(appPath, 'PlugIns'))
    .catch((error: unknown): string[] => {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return [];
      throw error;
    });
  if (!plugins.includes('AgentDeviceRunnerUITests.xctest')) {
    throw limrunRunnerError(
      'limrun_runner_products_invalid',
      'The app does not contain AgentDeviceRunnerUITests.xctest',
      {},
      'INVALID_ARGS',
    );
  }
  // A remote simulator cannot reach the build machine's Xcode, so the runner must carry XCTest
  // itself. Xcode 26 embeds it in the runner app; Xcode 27 leaves it out and resolves it from the
  // build machine, so such a runner never starts on a Limrun simulator.
  const xctest = await fs
    .stat(path.join(appPath, 'Frameworks', 'XCTest.framework'))
    .catch(() => null);
  if (!xctest?.isDirectory()) {
    throw limrunRunnerError(
      'limrun_runner_products_invalid',
      'The Limrun XCTest runner does not embed XCTest.framework',
      {
        hint: 'Build and package the simulator runner with Xcode 26, for example with DEVELOPER_DIR set to an Xcode 26 install.',
      },
      'INVALID_ARGS',
    );
  }
  await fs.cp(appPath, path.join(products, 'Runner.app'), { recursive: true });
  await writeLimrunRunnerConfiguration(products, input.bindAddress, input.endpoint);
  return products;
}

export async function writeLimrunRunnerConfiguration(
  directory: string,
  bindAddress: string,
  endpoint: { port: number; token: string },
): Promise<void> {
  const string = (value: string) => `<string>${escapeXmlTextAndAttribute(value)}</string>`;
  const environment = runnerListenerEnv(endpoint, bindAddress);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>AgentDeviceRunnerUITests</key><dict>
<key>BlueprintName</key><string>AgentDeviceRunnerUITests</string>
<key>ProductModuleName</key><string>AgentDeviceRunnerUITests</string>
<key>TestHostPath</key><string>__TESTROOT__/Runner.app</string>
<key>TestBundlePath</key><string>__TESTHOST__/PlugIns/AgentDeviceRunnerUITests.xctest</string>
<key>IsUITestBundle</key><true/>
<key>UITargetAppPath</key><string>__TESTROOT__/Runner.app</string>
${Object.entries(RUNNER_XCTESTRUN_CAPTURE_OPTIONS)
  .map(([key, value]) => `<key>${key}</key>${string(value)}`)
  .join('')}
<key>OnlyTestIdentifiers</key><array><string>RunnerTests/testCommand</string></array>
<key>EnvironmentVariables</key><dict>${Object.entries(environment)
    .map(([key, value]) => `<key>${key}</key>${string(value)}`)
    .join('')}</dict>
</dict><key>__xctestrun_metadata__</key><dict><key>FormatVersion</key><integer>1</integer></dict></dict></plist>`;
  await fs.writeFile(path.join(directory, 'Runner.xctestrun'), xml, { mode: 0o600 });
}

/** The SDK syncFolder cannot accept cancellation and may load the omitted xdelta WASM even with gzip. */
export async function uploadLimrunRunnerProducts(
  directory: string,
  apiUrl: string,
  token: string,
  signal: AbortSignal,
  payloadPaths?: readonly string[],
): Promise<void> {
  const files: Array<{ path: string; size: number; sha256: string; mode: number }> = [];
  const visit = async (relative: string) => {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      signal.throwIfAborted();
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(name);
        continue;
      }
      if (!entry.isFile())
        throw limrunRunnerError(
          'limrun_runner_products_invalid',
          'Runner products must contain regular files',
          {},
          'INVALID_ARGS',
        );
      const file = path.join(directory, name);
      const stat = await fs.stat(file);
      const sha256 = createHash('sha256')
        .update(await fs.readFile(file, { signal }))
        .digest('hex');
      files.push({ path: name, size: stat.size, mode: stat.mode & 0o777, sha256 });
    }
  };
  await visit('');
  const selected = payloadPaths ? files.filter((file) => payloadPaths.includes(file.path)) : files;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    const result = await upload(attempt === 0 ? selected : files);
    if (result.ok === true && !result.needFull?.length) return;
    if (!result.needFull?.length || attempt === 1) {
      throw limrunRunnerError(
        'limrun_runner_upload_failed',
        'Limrun runner products could not be synchronized',
        {
          needFull: result.needFull,
        },
      );
    }
  }

  async function upload(payloads: typeof files): Promise<{ ok?: boolean; needFull?: string[] }> {
    const metadata = Buffer.from(
      JSON.stringify({
        id: randomUUID(),
        rootName: path.basename(directory),
        install: false,
        files,
        payloads: payloads.map((file) => ({
          kind: 'full',
          path: file.path,
          targetSha256: file.sha256,
          length: file.size,
        })),
      }),
    );
    const size = Buffer.alloc(4);
    size.writeUInt32BE(metadata.length);
    async function* body() {
      yield size;
      yield metadata;
      for (const file of payloads)
        yield* createReadStream(path.join(directory, file.path), { signal });
    }
    const stream = createGzip();
    const compression = pipeline(Readable.from(body()), stream, { signal }).catch(() => {});
    try {
      const response = await fetch(`${apiUrl}/sync`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'gzip',
        },
        body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
        duplex: 'half',
        signal,
        redirect: 'error',
      } as RequestInit & { duplex: 'half' });
      if (!response.ok) {
        await response.body?.cancel();
        throw limrunRunnerError(
          'limrun_runner_upload_failed',
          `Limrun runner upload failed (${response.status})`,
          {
            status: response.status,
          },
        );
      }
      return (await response.json()) as { ok?: boolean; needFull?: string[] };
    } finally {
      stream.destroy();
      await compression;
    }
  }
}
