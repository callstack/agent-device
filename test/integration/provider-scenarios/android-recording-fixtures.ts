import fs from 'node:fs';
import path from 'node:path';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import {
  restoreEnv,
  createProviderScenarioHarness,
  likelyPlayableMp4Container,
} from './harness.ts';

export type ProviderScenarioDaemon = Awaited<ReturnType<typeof createProviderScenarioHarness>>;
export type ProviderScenarioRpcResult = Awaited<ReturnType<ProviderScenarioDaemon['callCommand']>>;
export type PullCall = { remotePath: string; localPath: string };

export async function stopAndroidRecording(
  daemon: ProviderScenarioDaemon,
  outPath?: string,
): Promise<ProviderScenarioRpcResult> {
  return await daemon.callCommand('record', outPath ? ['stop', outPath] : ['stop'], {
    platform: 'android',
    serial: PROVIDER_SCENARIO_ANDROID.id,
  });
}

// Strips PATH so isPlayableVideo cannot reach swiftc and deterministically validates pulled
// files via the container sniff.
export async function withAndroidProviderScenarioEnv(
  tmpDir: string,
  runScenario: () => Promise<void>,
): Promise<void> {
  const previousPath = process.env.PATH;
  const previousSwiftCacheDir = process.env.AGENT_DEVICE_SWIFT_CACHE_DIR;
  process.env.PATH = tmpDir;
  process.env.AGENT_DEVICE_SWIFT_CACHE_DIR = path.join(tmpDir, 'swift-cache');
  try {
    await runScenario();
  } finally {
    restoreEnv('PATH', previousPath);
    restoreEnv('AGENT_DEVICE_SWIFT_CACHE_DIR', previousSwiftCacheDir);
  }
}

export type AndroidRecordingManifestFixtureOptions = {
  outPath: string;
  remotePath: string;
  sessionName: string;
  sessionScope?: { kind: 'cwd'; id: string };
  status?: 'pending' | 'live' | 'rotating';
  pendingRemotePath?: string;
  pendingRemotePid?: string;
  remotePid?: string;
  startedAt?: number;
  chunks?: Array<{ index: number; path: string; remotePath: string }>;
};

export function buildAndroidRecordingManifest(options: AndroidRecordingManifestFixtureOptions) {
  const startedAt = options.startedAt ?? 123456789;
  const status = options.status ?? 'live';
  return {
    version: 1,
    sessionName: options.sessionName,
    sessionScope: options.sessionScope,
    recordingId: `recording-${startedAt}`,
    deviceId: PROVIDER_SCENARIO_ANDROID.id,
    startedAt,
    outPath: options.outPath,
    showTouches: true,
    exportQuality: 'medium',
    current: buildAndroidRecordingManifestCurrent(options, startedAt, status),
    pending: buildAndroidRecordingManifestPending(options, status),
    pendingRemotePid: options.pendingRemotePid ?? (status === 'rotating' ? '4322' : '4321'),
    chunks: buildAndroidRecordingManifestChunks(options),
  };
}

function buildAndroidRecordingManifestCurrent(
  options: AndroidRecordingManifestFixtureOptions,
  startedAt: number,
  status: 'pending' | 'live' | 'rotating',
) {
  if (status === 'pending') return undefined;
  return {
    remotePath: options.remotePath,
    remotePid: options.remotePid ?? '4321',
    startedAt,
  };
}

function buildAndroidRecordingManifestPending(
  options: AndroidRecordingManifestFixtureOptions,
  status: 'pending' | 'live' | 'rotating',
) {
  return status === 'pending' || status === 'rotating'
    ? { remotePath: options.pendingRemotePath ?? options.remotePath }
    : undefined;
}

function buildAndroidRecordingManifestChunks(options: AndroidRecordingManifestFixtureOptions) {
  return (
    options.chunks ?? [
      {
        index: 1,
        path: options.outPath,
        remotePath: options.remotePath,
      },
    ]
  );
}

export function androidAdbResult(args: string[]): {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutBuffer?: Buffer;
} {
  const command = args.join(' ');
  if (command === 'shell getprop sys.boot_completed') {
    return { stdout: '1\n', stderr: '', exitCode: 0 };
  }
  if (isAndroidScreenrecordStartCommand(command)) {
    return { stdout: '4321\n', stderr: '', exitCode: 0 };
  }
  if (/^shell stat -c %s \/sdcard\/agent-device-recording-\d+\.mp4$/.test(command)) {
    return { stdout: '2048\n', stderr: '', exitCode: 0 };
  }
  if (args[0] === 'pull' && typeof args[2] === 'string') {
    writePlayableMp4(args[2]);
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  if (command === 'shell ps -o pid= -p 4321') {
    return { stdout: '', stderr: '', exitCode: 1 };
  }
  return { stdout: '', stderr: '', exitCode: 0 };
}

function isAndroidScreenrecordStartCommand(command: string): boolean {
  return /^shell screenrecord --bit-rate (?:8000000|20000000) \/sdcard\/agent-device-recording-\d+\.mp4 >\/dev\/null 2>&1 & echo \$!$/.test(
    command,
  );
}

export function writePlayableMp4(filePath: string): void {
  const fixturePath = path.join(process.cwd(), 'website/docs/public/agent-device-contacts.mp4');
  if (fs.existsSync(fixturePath)) {
    fs.copyFileSync(fixturePath, filePath);
    return;
  }
  fs.writeFileSync(filePath, likelyPlayableMp4Container());
}
