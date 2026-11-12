import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  AppDeploymentResult,
  MaterializedAppSource,
} from '@agent-device/contracts/app-deployment-runtime';
import { runCmd } from '@agent-device/host-kit/command';
import { AppError } from '@agent-device/kernel/errors';
import type { EnvMap } from '@agent-device/kernel/source-value';
import type { RevylClient } from './revyl-client.ts';
import type { RevylWorkerActionResponse } from './revyl-types.ts';

/**
 * The whole install's budget: packing, upload, and Revyl's install. It stays inside the daemon's
 * share of the install command's 480 s envelope, so the plugin reports its own timeout before the
 * client gives up and resets the daemon that holds the rented device.
 */
const REVYL_INSTALL_BUDGET_MS = 420_000;
const POLL_BASE_DELAY_MS = 500;
const POLL_MAX_DELAY_MS = 5_000;

/** What an install reads from the session it targets. */
export type RevylDeploymentSession = Readonly<{
  runId: string;
  sessionId: string;
  platform: 'ios' | 'android';
  client: RevylClient;
}>;

type PackagedBuild = Readonly<{
  filePath: string;
  contentType: string;
  cleanup(): Promise<void>;
}>;

/**
 * Installs a local build on a running Revyl session: the build goes to the session's own storage, and
 * the worker installs it from there. A simulator `.app` directory is packed as a gzip tar, which Revyl
 * accepts for iOS the same as a zip.
 */
export async function deployRevylApp(
  session: RevylDeploymentSession,
  appPath: string,
  env: Readonly<EnvMap>,
  signal: AbortSignal,
  budgetMs = REVYL_INSTALL_BUDGET_MS,
): Promise<AppDeploymentResult> {
  const budget = AbortSignal.timeout(budgetMs);
  const scoped = AbortSignal.any([signal, budget]);
  try {
    return await uploadAndInstall(session, appPath, env, scoped);
  } catch (error) {
    if (signal.aborted)
      throw installStopped('request_canceled', 'The install was canceled.', error);
    if (budget.aborted) {
      throw installStopped(
        'provider-unconfirmed',
        `Revyl did not finish the install within ${budgetMs / 1000} s.`,
        error,
      );
    }
    throw error;
  }
}

async function uploadAndInstall(
  session: RevylDeploymentSession,
  appPath: string,
  env: Readonly<EnvMap>,
  signal: AbortSignal,
): Promise<AppDeploymentResult> {
  const build = await packageBuild(session.platform, appPath, env, signal);
  try {
    const body = new Uint8Array(await fs.readFile(build.filePath));
    const upload = await session.client.createSessionArtifactUpload(
      session.sessionId,
      body.byteLength,
      build.contentType,
      signal,
    );
    await session.client.uploadSessionArtifact(upload.upload_url, body, build.contentType, signal);
    return deploymentResult(
      session.platform,
      await installAndWait(session, upload.download_url, signal),
    );
  } finally {
    await build.cleanup();
  }
}

function installStopped(reason: string, message: string, cause: unknown): AppError {
  return new AppError(
    'COMMAND_FAILED',
    message,
    {
      reason,
      hint: 'Check the session in Revyl; an install it already accepted may still complete.',
    },
    cause,
  );
}

/** The build files Revyl installs as they are, by platform: suffix, then upload content type. */
const FILE_BUILDS: Readonly<Record<'ios' | 'android', ReadonlyArray<readonly [string, string]>>> = {
  ios: [
    ['.zip', 'application/zip'],
    ['.tar.gz', 'application/gzip'],
    ['.tgz', 'application/gzip'],
  ],
  android: [['.apk', 'application/vnd.android.package-archive']],
};

async function packageBuild(
  platform: 'ios' | 'android',
  appPath: string,
  env: Readonly<EnvMap>,
  signal: AbortSignal,
): Promise<PackagedBuild> {
  const stat = await fs.stat(appPath);
  const lower = appPath.toLowerCase().replace(/[\\/]+$/, '');
  if (platform === 'ios' && stat.isDirectory() && lower.endsWith('.app')) {
    return await packAppBundle(appPath, env, signal);
  }
  const match = stat.isFile()
    ? FILE_BUILDS[platform].find(([suffix]) => lower.endsWith(suffix))
    : undefined;
  if (match) return fileBuild(appPath, match[1]);
  throw unsupportedBuild(platform, appPath);
}

/** Packs a simulator `.app` directory as a gzip tar, which Revyl accepts for iOS. */
async function packAppBundle(
  appPath: string,
  env: Readonly<EnvMap>,
  signal: AbortSignal,
): Promise<PackagedBuild> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `agent-device-revyl-${randomUUID()}-`));
  const archive = path.join(tempDir, `${path.basename(appPath)}.tar.gz`);
  const cleanup = async () => await fs.rm(tempDir, { recursive: true, force: true });
  try {
    await runCmd('tar', ['czf', archive, '-C', path.dirname(appPath), path.basename(appPath)], {
      // Keeps macOS tar from adding AppleDouble `._` entries to the bundle.
      env: { ...env, COPYFILE_DISABLE: '1' },
      signal,
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { filePath: archive, contentType: 'application/gzip', cleanup };
}

function unsupportedBuild(platform: 'ios' | 'android', appPath: string): AppError {
  return platform === 'ios'
    ? new AppError(
        'INVALID_ARGS',
        'Revyl installs an iOS simulator build: a .app directory, or one zipped or tarred.',
        {
          reason: 'unsupported_app_artifact',
          appPath,
          hint: 'Build for the iOS simulator; a device .ipa does not run on a simulator.',
        },
      )
    : new AppError('INVALID_ARGS', 'Revyl installs an Android build from an .apk file.', {
        reason: 'unsupported_app_artifact',
        appPath,
        hint: 'Pass the .apk the build produced.',
      });
}

function fileBuild(filePath: string, contentType: string): PackagedBuild {
  return { filePath, contentType, cleanup: async () => undefined };
}

async function installAndWait(
  session: RevylDeploymentSession,
  appUrl: string,
  signal: AbortSignal,
): Promise<RevylWorkerActionResponse> {
  const accepted = await session.client.startInstall(
    session.runId,
    { app_url: appUrl, platform: session.platform },
    signal,
  );
  const installId = accepted.install_id?.trim();
  if (accepted.status !== 'accepted' || !installId) {
    throw new AppError('COMMAND_FAILED', 'Revyl did not accept the app install.', {
      reason: 'provider-refused',
      ...(accepted.status === undefined ? {} : { providerDetail: accepted.status }),
    });
  }
  let delay = POLL_BASE_DELAY_MS;
  for (;;) {
    await sleep(delay, undefined, { signal });
    const status = await session.client.getInstallStatus(session.runId, installId, signal);
    if (
      status.status === 'completed' ||
      status.status === 'failed' ||
      status.status === 'cancelled'
    ) {
      return requireInstalled(status.status, status.result ?? undefined);
    }
    if (status.status !== 'running') {
      throw new AppError('COMMAND_FAILED', `Revyl reported install status "${status.status}".`, {
        reason: 'provider-refused',
        installId,
      });
    }
    delay = Math.min(delay * 2, POLL_MAX_DELAY_MS);
  }
}

function requireInstalled(
  status: string,
  result: RevylWorkerActionResponse | undefined,
): RevylWorkerActionResponse {
  const error = typeof result?.error === 'string' && result.error !== '' ? result.error : undefined;
  const succeeded = result?.success ?? result?.Success;
  if (status === 'completed' && result !== undefined && succeeded !== false && !error)
    return result;
  throw new AppError(
    'COMMAND_FAILED',
    `Revyl could not install the app${error === undefined ? '' : `: ${error}`}`,
    {
      reason: 'provider-refused',
      installStatus: status,
      ...(error === undefined ? {} : { providerDetail: error }),
    },
  );
}

function deploymentResult(
  platform: 'ios' | 'android',
  result: RevylWorkerActionResponse,
): AppDeploymentResult {
  const id =
    (platform === 'ios' ? result.bundle_id : (result.package_name ?? result.bundle_id)) ??
    undefined;
  if (!id) return {};
  return platform === 'ios'
    ? { bundleId: id, launchTarget: id }
    : { packageName: id, launchTarget: id };
}

/** The app a materialized build names, read before Revyl installs it. */
export function materializedIdentity(artifact: MaterializedAppSource): AppDeploymentResult {
  const id = artifact.bundleId ?? artifact.packageName;
  return {
    ...(artifact.bundleId ? { bundleId: artifact.bundleId } : {}),
    ...(artifact.packageName ? { packageName: artifact.packageName } : {}),
    ...(artifact.appName ? { appName: artifact.appName } : {}),
    ...(id ? { launchTarget: id } : {}),
  };
}
