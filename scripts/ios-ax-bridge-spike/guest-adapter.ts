import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { DEFAULT_SPIKE_LIMITS } from './limits.ts';
import { PersistentFramedProcess } from './persistent-process.ts';
import { failureResponse } from './protocol.ts';
import type { AcquisitionAdapter, AdapterOptions } from './adapter.ts';
import type { ResourceLimits, SpikeRequest } from './types.ts';

const CANDIDATE = 'guest-simulator-framework-bridge' as const;

export const GUEST_MECHANISM_EVIDENCE = {
  implementation: 'idb',
  release: 'v1.5.2',
  companionArchive: 'idb-companion.macos-arm64.tar.gz',
  companionSha256: 'f17b718a513931705542a7fbfa9cfc11895ee191562c9ffd2343cf7f8254bc08',
  cliArchive: 'idb-cli-1.5.2.arm64_tahoe.bottle.tar.gz',
  cliSha256: 'ce574aa28ecf3e33a5249d60578a1dc2f609ec82f7e240907b6d9fde6251dda6',
  backend: 'axbridge-persistent',
  outputFormat: 'default',
  client: 'persistent-in-repository-reader',
} as const;

export function createGuestSimulatorFrameworkBridgeAdapter(
  options: AdapterOptions,
): AcquisitionAdapter {
  const limits = options.limits ?? DEFAULT_SPIKE_LIMITS;
  const readerPath = path.join(
    options.repoRoot,
    'scripts',
    'ios-ax-bridge-spike',
    'guest-reader.py',
  );
  if (
    !options.guestCompanion ||
    !fs.existsSync(options.guestCompanion) ||
    !options.guestSitePackages ||
    !fs.existsSync(options.guestSitePackages) ||
    !fs.existsSync(readerPath)
  ) {
    return unavailableAdapter('guest-tool-unavailable');
  }
  const session = new GuestSession({
    companionPath: options.guestCompanion,
    python: options.guestPython ?? 'python3',
    sitePackages: options.guestSitePackages,
    readerPath,
    repoRoot: options.repoRoot,
    limits,
  });
  return {
    candidate: CANDIDATE,
    acquireBatch: (requests, acquireOptions) => session.acquireBatch(requests, acquireOptions),
    close: () => session.close(),
    evidence: {
      terminateReaderOnNextBatch: () => session.terminateReaderOnNextBatchForEvidence(),
    },
  };
}

function unavailableAdapter(code: string): AcquisitionAdapter {
  return {
    candidate: CANDIDATE,
    async acquireBatch(requests) {
      return {
        responses: requests.map((request) =>
          failureResponse(
            request,
            { kind: 'unsupported-mechanism', code },
            {
              requestBytes: Buffer.byteLength(JSON.stringify(request)) + 1,
            },
          ),
        ),
        stderr: '',
      };
    },
  };
}

type GuestSessionOptions = Readonly<{
  companionPath: string;
  python: string;
  sitePackages: string;
  readerPath: string;
  repoRoot: string;
  limits: ResourceLimits;
}>;

class GuestSession {
  private readonly tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-guest-'));
  private readonly socketPath = path.join(this.tempDir, 'bridge.sock');
  private readonly companionPath: string;
  private companion?: ChildProcessWithoutNullStreams;
  private companionUdid?: string;
  private companionStderr = '';
  private closed = false;
  private readonly reader: PersistentFramedProcess;

  constructor(options: GuestSessionOptions) {
    this.companionPath = options.companionPath;
    this.reader = new PersistentFramedProcess({
      file: options.python,
      args: [options.readerPath, '--socket', this.socketPath],
      cwd: options.repoRoot,
      env: {
        PYTHONPATH: [options.sitePackages, process.env.PYTHONPATH]
          .filter(Boolean)
          .join(path.delimiter),
        PYTHONUNBUFFERED: '1',
      },
      limits: options.limits,
      beforeStart: (requests) => this.ensureCompanion(requests[0]!.simulatorUdid, options.limits),
    });
  }

  async acquireBatch(
    requests: readonly SpikeRequest[],
    options: Readonly<{ signal?: AbortSignal }> = {},
  ) {
    const result = await this.reader.acquireBatch(requests, options);
    const stderr = this.takeCompanionStderr();
    return stderr ? { ...result, stderr: `${stderr}${result.stderr}` } : result;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.reader.close();
    await terminateAndWait(this.companion);
    this.companion = undefined;
    fs.rmSync(this.tempDir, { recursive: true, force: true });
  }

  terminateReaderOnNextBatchForEvidence(): void {
    this.reader.terminateReaderOnNextBatchForEvidence();
  }

  private async ensureCompanion(udid: string, limits: ResourceLimits): Promise<void> {
    if (this.closed) throw new GuestStartError('guest-adapter-closed');
    if (this.companion && !this.companion.killed && this.companion.exitCode === null) {
      if (this.companionUdid !== udid) throw new GuestStartError('guest-udid-changed');
      return;
    }
    fs.rmSync(this.socketPath, { force: true });
    const companion = spawn(
      this.companionPath,
      [
        '--udid',
        udid,
        '--grpc-domain-sock',
        this.socketPath,
        '--log-level',
        'warning',
        '--idle-shutdown-time',
        '3600',
      ],
      { cwd: path.dirname(this.companionPath), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.companion = companion;
    this.companionUdid = udid;
    companion.stderr.on('data', (chunk: Buffer | string) => this.appendCompanionStderr(chunk));
    try {
      const socket = await waitForCompanion(companion, limits.maxDurationMs);
      if (socket !== this.socketPath) throw new GuestStartError('guest-companion-socket-mismatch');
      companion.stdout.resume();
      companion.on('error', (error: NodeJS.ErrnoException) =>
        this.appendCompanionStderr(error.message),
      );
    } catch (error) {
      if (this.companion === companion) this.companion = undefined;
      terminate(companion);
      throw error;
    }
  }

  private appendCompanionStderr(chunk: Buffer | string): void {
    if (this.companionStderr.length >= 64 * 1024) return;
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    this.companionStderr += text.slice(0, 64 * 1024 - this.companionStderr.length);
  }

  private takeCompanionStderr(): string {
    const stderr = this.companionStderr;
    this.companionStderr = '';
    return stderr;
  }
}

class GuestStartError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'GuestStartError';
    this.code = code;
  }
}

async function waitForCompanion(
  companion: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      terminate(companion);
      reject(new GuestStartError('guest-companion-start-timeout'));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      companion.stdout.off('data', onData);
      companion.off('error', onError);
      companion.off('close', onClose);
    };
    const onData = (chunk: Buffer | string): void => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const value = JSON.parse(line) as { grpc_path?: unknown };
          if (typeof value.grpc_path === 'string') {
            cleanup();
            resolve(value.grpc_path);
            return;
          }
        } catch {
          continue;
        }
      }
    };
    const onError = (): void => {
      cleanup();
      reject(new GuestStartError('guest-companion-spawn-failed'));
    };
    const onClose = (): void => {
      cleanup();
      reject(new GuestStartError('guest-companion-exited-before-ready'));
    };
    companion.stdout.on('data', onData);
    companion.once('error', onError);
    companion.once('close', onClose);
  });
}

function terminate(child: ChildProcessWithoutNullStreams | undefined): void {
  if (child && !child.killed) child.kill('SIGTERM');
}

async function terminateAndWait(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  terminate(child);
  await exited;
}
