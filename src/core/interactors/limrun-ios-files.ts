import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  readSimctlContainerPath,
  type AppleToolProvider,
  type AppleToolExecOptions,
  type AppleToolSubcommandExecutor,
} from '@agent-device/platform-apple/tool-provider';
import type { LimrunRuntimeDependencies } from '@agent-device/provider-limrun';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { downloadLimrunFile } from '../limrun-download-file.ts';

type Session = Parameters<LimrunRuntimeDependencies['ios']['createRunner']>[0];
type Files = AppleToolProvider['simulatorFiles'];
type Container = Parameters<Files['openContainer']>[0];

export function createLimrunSimulatorFiles(
  session: Session,
  lifetime: AbortSignal,
  runSimctl: AppleToolSubcommandExecutor,
  requestSignal?: AbortSignal,
): { simulatorFiles: Files; readInfoPlist: AppleToolProvider['simulatorApps']['readInfoPlist'] } {
  const signalFor = (signal?: AbortSignal) =>
    AbortSignal.any(
      [lifetime, requestSignal, signal].filter((value): value is AbortSignal => Boolean(value)),
    );
  const operation = async <T>(
    options: AppleToolExecOptions,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any(
      [
        lifetime,
        options.requestCancellation === 'ignore' ? undefined : requestSignal,
        options.signal,
        deadline,
      ].filter((value): value is AbortSignal => Boolean(value)),
    );
    try {
      signal.throwIfAborted();
      return await run(signal);
    } catch (error) {
      if (signal.aborted) {
        if (signal.reason === deadline.reason && deadline.aborted)
          throw new AppError('COMMAND_FAILED', 'Remote simulator file operation timed out', {
            timeoutMs,
          });
        if (signal.reason instanceof AppError) throw signal.reason;
        throw createRequestCanceledError(undefined, signal.reason);
      }
      throw error;
    }
  };
  const urlFor = (route: string, name: string, container?: Container) => {
    const url = new URL(`${session.apiUrl.replace(/\/$/, '')}/${route}`);
    url.searchParams.set(route === 'files/list' ? 'path' : 'name', name);
    if (container) {
      url.searchParams.set('bundleId', container.bundleId);
      url.searchParams.set('containerType', container.containerType);
    }
    return url;
  };
  const request = async (method: string, url: URL, signal: AbortSignal, body?: Uint8Array) => {
    signal.throwIfAborted();
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${session.token}`,
        ...(body ? { 'Content-Type': 'application/octet-stream' } : {}),
      },
      body: body as BodyInit | undefined,
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError('COMMAND_FAILED', `Limrun file ${method} failed (${response.status})`, {
        status: response.status,
      });
    }
    return response;
  };
  const files: Files = {
    copyToHost: async (input) => {
      await downloadLimrunFile({
        url: urlFor('files', input.sourcePath, input).href,
        headers: { Authorization: `Bearer ${session.token}` },
        destinationPath: input.destinationPath,
        timeoutMs: input.timeoutMs,
        signal: signalFor(input.signal),
      });
    },
    openContainer: async (container) => {
      const result = await runSimctl(
        ['get_app_container', session.device.id, container.bundleId, container.containerType],
        { signal: container.signal, timeoutMs: container.timeoutMs },
      );
      if (!(await readSimctlContainerPath(result.stdout))) return null;
      return {
        list: () =>
          operation(container, async (signal) => {
            const response = await request('GET', urlFor('files/list', '', container), signal);
            const result = (await response.json()) as { entries: Array<{ name: string }> };
            return result.entries.map((entry) => entry.name);
          }),
        remove: (name) =>
          operation(container, async (signal) => {
            const response = await request('DELETE', urlFor('files', name, container), signal);
            await response.body?.cancel();
          }),
        ensureDirectory: (directory) =>
          operation(container, async (signal) => {
            // Upload creates parents; removing the unique marker leaves the requested directory.
            const name = `${directory}/.agent-device-${randomUUID()}`;
            const response = await request(
              'PUT',
              urlFor('files', name, container),
              signal,
              new Uint8Array(),
            );
            await response.body?.cancel();
            const removed = await request('DELETE', urlFor('files', name, container), signal);
            await removed.body?.cancel();
          }),
      };
    },
    stageFile: async (localPath, inputSignal) => {
      const url = urlFor('files', `agent-device-${randomUUID()}${path.extname(localPath)}`);
      const result = await operation({ signal: inputSignal }, async (signal) => {
        const response = await request(
          'PUT',
          url,
          signal,
          await fs.readFile(localPath, { signal }),
        );
        return (await response.json()) as { path: string };
      });
      return {
        path: result.path,
        [Symbol.asyncDispose]: () =>
          operation({ requestCancellation: 'ignore', timeoutMs: 15_000 }, async (signal) => {
            const response = await request('DELETE', url, signal);
            await response.body?.cancel();
          }),
      };
    },
  };
  const metadata = new Map<string, Promise<Record<string, unknown> | null>>();

  return {
    simulatorFiles: files,
    readInfoPlist: async (input) => {
      const key = input.bundleId;
      let pending = metadata.get(key);
      if (!pending) {
        pending = readLimrunAppInfo(
          session,
          input.bundleId,
          signalFor(input.signal),
          input.timeoutMs,
        );
        metadata.set(key, pending);
      }
      try {
        return await pending;
      } catch (error) {
        metadata.delete(key);
        throw error;
      }
    },
  };
}

export async function readLimrunAppInfo(
  access: { apiUrl: string; token: string },
  bundleId: string,
  signal: AbortSignal,
  timeoutMs = 15_000,
): Promise<Record<string, unknown> | null> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-app-plist-'));
  try {
    const destinationPath = path.join(directory, 'Info.plist');
    const url = new URL(`${access.apiUrl.replace(/\/$/, '')}/files`);
    url.search = new URLSearchParams({
      name: 'Info.plist',
      bundleId,
      containerType: 'app',
    }).toString();
    await downloadLimrunFile({
      url: url.href,
      headers: { Authorization: `Bearer ${access.token}` },
      destinationPath,
      timeoutMs,
      signal,
    });
    const { parseApplePlist } = await import('@agent-device/platform-apple/tool-provider');
    return await parseApplePlist(await fs.readFile(destinationPath, { signal }));
  } catch (error) {
    if (error instanceof AppError && error.details?.statusCode === 404) return null;
    throw error;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
