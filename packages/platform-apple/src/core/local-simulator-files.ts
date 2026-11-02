import { readSimctlContainerPath, scopeSimctlArgsForDevice } from './simctl.ts';
import path from 'node:path';
import {
  copyHostFile,
  ensureHostDirectory,
  hostFileStat,
  readHostDirectory,
  removeHostPath,
} from '@agent-device/host-kit/host-file';
import { AppError } from '@agent-device/kernel/errors';
import { requireExecSuccess } from '@agent-device/host-kit/command';
import type {
  AppleSimulatorFileCopy,
  AppleSimctlToolProvider,
  AppleSimulatorContainerRequest,
  AppleSimulatorContainer,
} from './tool-provider-types.ts';

const containerPaths = new Map<string, string>();

export async function copySimulatorFileToHost(
  simctl: AppleSimctlToolProvider,
  request: AppleSimulatorFileCopy,
): Promise<void> {
  request.signal?.throwIfAborted();
  if (path.isAbsolute(request.sourcePath)) {
    await copyFromContainer('', request);
    return;
  }
  const key = JSON.stringify([request.device.id, request.bundleId, request.containerType]);
  const cached = containerPaths.get(key);
  if (cached) {
    try {
      await copyFromContainer(cached, request);
      return;
    } catch (error) {
      request.signal?.throwIfAborted();
      const exists = await hostFileStat(cached).then(
        () => true,
        (statError: NodeJS.ErrnoException) => {
          if (statError.code === 'ENOENT') return false;
          throw error;
        },
      );
      if (exists) throw error;
      containerPaths.delete(key);
    }
  }
  const result = await simctl.run(
    scopeSimctlArgsForDevice(request.device, [
      'get_app_container',
      request.device.id,
      request.bundleId,
      request.containerType,
    ]),
    { timeoutMs: request.timeoutMs, signal: request.signal },
  );
  const containerPath = readSimctlContainerPath(result.stdout);
  if (!containerPath) {
    throw new AppError(
      'COMMAND_FAILED',
      `simctl get_app_container returned no ${request.containerType} container path`,
    );
  }
  containerPaths.set(key, containerPath);
  await copyFromContainer(containerPath, request);
}

async function copyFromContainer(
  containerPath: string,
  request: AppleSimulatorFileCopy,
): Promise<void> {
  request.signal?.throwIfAborted();
  const sourcePath = path.isAbsolute(request.sourcePath)
    ? request.sourcePath
    : path.join(containerPath, request.sourcePath);
  await ensureHostDirectory(path.dirname(request.destinationPath));
  await copyHostFile(sourcePath, request.destinationPath);
}

export async function openSimulatorContainer(
  simctl: AppleSimctlToolProvider,
  request: AppleSimulatorContainerRequest,
): Promise<AppleSimulatorContainer | null> {
  const { device, bundleId, containerType, timeoutMs, signal } = request;
  signal?.throwIfAborted();
  const result = requireExecSuccess(
    await simctl.run(
      scopeSimctlArgsForDevice(device, ['get_app_container', device.id, bundleId, containerType]),
      {
        allowFailure: true,
        timeoutMs,
        signal,
      },
    ),
    `simctl get_app_container failed for ${bundleId}`,
  );
  const containerPath = readSimctlContainerPath(result.stdout);
  if (containerPath === undefined) return null;
  return {
    path: containerPath,
    list: () => readHostDirectory(containerPath),
    remove: (relativePath) => removeHostPath(path.join(containerPath, relativePath)),
    ensureDirectory: (relativePath) => ensureHostDirectory(path.join(containerPath, relativePath)),
  };
}
