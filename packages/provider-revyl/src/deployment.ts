import fs from 'node:fs/promises';
import type {
  AppDeploymentResult,
  MaterializedAppSource,
} from '@agent-device/contracts/app-deployment-runtime';
import { packGzipTar } from '@agent-device/host-kit/gzip-tar';
import { Deadline, type DeadlineClock, pollUntilSettled } from '@agent-device/host-kit/retry';
import { AppError } from '@agent-device/kernel/errors';
import type { EnvMap } from '@agent-device/kernel/source-value';
import {
  REVYL_PROVIDER_REASONS,
  type RevylClient,
  type RevylProviderReason,
} from './revyl-client.ts';
import type { RevylWorkerActionResponse } from './revyl-types.ts';

/**
 * The whole install's budget: packing, upload, and Revyl's install. It stays inside the daemon's
 * share of the install command's 480 s envelope, so the plugin reports its own timeout before the
 * client gives up and resets the daemon that holds the rented device.
 */
const REVYL_INSTALL_BUDGET_MS = 420_000;
/** How often `install_status` is read while Revyl installs; an install takes seconds to minutes. */
const INSTALL_POLL_INTERVAL_MS = 1_000;

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
  cleanup(): void;
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
  const deadline = Deadline.fromTimeoutMs(budgetMs);
  const budget = AbortSignal.timeout(budgetMs);
  const scoped = AbortSignal.any([signal, budget]);
  const timedOut = (cause?: unknown) =>
    installStopped(
      REVYL_PROVIDER_REASONS.unconfirmed.reason,
      `Revyl did not finish the install within ${budgetMs / 1000} s.`,
      cause,
    );
  try {
    const installed = await uploadAndInstall(session, appPath, env, scoped, deadline);
    if (!installed) throw timedOut();
    return installed;
  } catch (error) {
    if (signal.aborted)
      throw installStopped('request_canceled', 'The install was canceled.', error);
    if (budget.aborted) throw timedOut(error);
    throw error;
  }
}

/** The installed app, or `undefined` when Revyl was still installing at the deadline. */
async function uploadAndInstall(
  session: RevylDeploymentSession,
  appPath: string,
  env: Readonly<EnvMap>,
  signal: AbortSignal,
  deadline: DeadlineClock,
): Promise<AppDeploymentResult | undefined> {
  const build = await packageBuild(session.platform, appPath, env, signal);
  try {
    const { size } = await fs.stat(build.filePath);
    const upload = await session.client.createSessionArtifactUpload(
      session.sessionId,
      size,
      build.contentType,
      signal,
    );
    await session.client.uploadSessionArtifact(
      upload.upload_url,
      { filePath: build.filePath, size },
      build.contentType,
      signal,
    );
    const installed = await installAndWait(session, upload.download_url, signal, deadline);
    return installed && deploymentResult(session.platform, installed);
  } finally {
    build.cleanup();
  }
}

/**
 * Why an install stopped short of a confirmed result: the provider's own verdicts, or the caller's
 * cancellation. `request_canceled` is the kernel's cancellation vocabulary, which no provider table
 * re-declares, so it is named here as the one spelling this wrapper also takes.
 */
type RevylInstallStopReason = RevylProviderReason | 'request_canceled';

function installStopped(reason: RevylInstallStopReason, message: string, cause: unknown): AppError {
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
    // Revyl accepts a gzip tar of the bundle for iOS the same as a zip.
    const packed = await packGzipTar(appPath, { env, signal });
    return {
      filePath: packed.archivePath,
      contentType: 'application/gzip',
      cleanup: packed.cleanup,
    };
  }
  const match = stat.isFile()
    ? FILE_BUILDS[platform].find(([suffix]) => lower.endsWith(suffix))
    : undefined;
  if (match) return fileBuild(appPath, match[1]);
  throw unsupportedBuild(platform, appPath);
}

function unsupportedBuild(platform: 'ios' | 'android', appPath: string): AppError {
  return platform === 'ios'
    ? new AppError(
        'INVALID_ARGS',
        'Revyl installs an iOS simulator build: a .app directory, or a .zip, .tar.gz, or .tgz of one.',
        {
          reason: REVYL_PROVIDER_REASONS.unsupportedAppArtifact.reason,
          appPath,
          hint: 'Build for the iOS simulator; a device .ipa does not run on a simulator.',
        },
      )
    : new AppError('INVALID_ARGS', 'Revyl installs an Android build from an .apk file.', {
        reason: REVYL_PROVIDER_REASONS.unsupportedAppArtifact.reason,
        appPath,
        hint: 'Pass the .apk the build produced.',
      });
}

function fileBuild(filePath: string, contentType: string): PackagedBuild {
  return { filePath, contentType, cleanup: () => undefined };
}

/** Revyl's install result once the install ends, or `undefined` if it is still running at the deadline. */
async function installAndWait(
  session: RevylDeploymentSession,
  appUrl: string,
  signal: AbortSignal,
  deadline: DeadlineClock,
): Promise<RevylWorkerActionResponse | undefined> {
  const accepted = await session.client.startInstall(
    session.runId,
    { app_url: appUrl, platform: session.platform },
    signal,
  );
  const installId = accepted.install_id?.trim();
  if (accepted.status !== 'accepted' || !installId) {
    throw new AppError('COMMAND_FAILED', 'Revyl did not accept the app install.', {
      reason: REVYL_PROVIDER_REASONS.refused.reason,
      ...(accepted.status === undefined ? {} : { providerDetail: accepted.status }),
    });
  }
  const { settled, value } = await pollUntilSettled({
    probe: async () => await session.client.getInstallStatus(session.runId, installId, signal),
    settled: (status) => status.status !== 'running',
    deadline,
    intervalMs: INSTALL_POLL_INTERVAL_MS,
    signal,
  });
  if (!settled) return undefined;
  if (value.status === 'completed' || value.status === 'failed' || value.status === 'cancelled') {
    return requireInstalled(value.status, value.result ?? undefined);
  }
  throw new AppError('COMMAND_FAILED', `Revyl reported install status "${value.status}".`, {
    reason: REVYL_PROVIDER_REASONS.refused.reason,
    installId,
  });
}

function requireInstalled(
  status: string,
  result: RevylWorkerActionResponse | undefined,
): RevylWorkerActionResponse {
  const error = typeof result?.error === 'string' && result.error !== '' ? result.error : undefined;
  const succeeded = result?.success ?? result?.Success;
  // A completed install without a result is still installed; the build supplies the identity.
  if (status === 'completed' && succeeded !== false && !error) return result ?? {};
  throw new AppError(
    'COMMAND_FAILED',
    `Revyl could not install the app${error === undefined ? '' : `: ${error}`}`,
    {
      reason: REVYL_PROVIDER_REASONS.refused.reason,
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
