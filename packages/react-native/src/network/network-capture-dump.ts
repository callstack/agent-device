import type { NetworkIncludeMode } from '@agent-device/kernel/contracts';
import type { NetworkProviderDumpResult } from '@agent-device/contracts/network-runtime';
import { AppError } from '@agent-device/kernel/errors';
import {
  readMetroSessionHints,
  resolveSessionMetroServerUrl,
} from '../metro/metro-session-hints.ts';
import {
  debuggerUrlOn,
  InspectorSession,
  listMetroInspectorTargets,
  selectReactNativeTarget,
} from '../react-devtools/metro-inspector.ts';
import { captureBufferNotes, projectCapturedNetworkEntries } from './network-capture-entries.ts';
import {
  NETWORK_CAPTURE_HEADER_CHARS,
  NETWORK_CAPTURE_MAX_ENTRIES,
  NETWORK_CAPTURE_RUNTIME_GLOBAL,
  NETWORK_CAPTURE_RUNTIME_SOURCE,
  NETWORK_CAPTURE_RUNTIME_VERSION,
} from './network-capture-runtime.ts';

const NETWORK_CAPTURE_BACKEND = 'react-native-app';

export type ReactNativeNetworkDumpInput = Readonly<{
  stateDir: string;
  session: string;
  appBundleId?: string;
  maxEntries: number;
  include: NetworkIncludeMode;
  maxPayloadChars: number;
  /** The dev server's device name of exactly one attached device; see `RuntimeTargetFilter`. */
  metroDeviceIdentity?: string;
}>;

function runtimeCall(
  session: InspectorSession,
  method: string,
  argument?: string,
): Promise<unknown> {
  return session.evaluate(`${NETWORK_CAPTURE_RUNTIME_GLOBAL}.${method}(${argument ?? ''})`);
}

function readJsonResult(value: unknown, method: string): Record<string, unknown> {
  if (typeof value !== 'string') {
    throw new AppError(
      'COMMAND_FAILED',
      `The app network capture returned no result for ${method}.`,
      { reason: 'network-capture-result-unreadable' },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AppError(
      'COMMAND_FAILED',
      `The app network capture returned unparseable JSON for ${method}.`,
      { reason: 'network-capture-result-unreadable' },
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError(
      'COMMAND_FAILED',
      `The app network capture returned a malformed result for ${method}.`,
      { reason: 'network-capture-result-unreadable' },
    );
  }
  return parsed as Record<string, unknown>;
}

function readBuffered(value: unknown): number | undefined {
  const stats = readJsonResult(value, 'stats');
  return typeof stats.buffered === 'number' ? stats.buffered : undefined;
}

/**
 * Reads the in-app network capture of the React Native runtime this session's dev server lists.
 * The first call installs the fetch/XMLHttpRequest capture, and an app that has requested nothing
 * since then reports `armed` with no entries. The buffer drains: a second dump never repeats an
 * entry, and an app reload resets the buffer together with its runtime.
 */
export async function dumpReactNativeAppNetwork(
  input: ReactNativeNetworkDumpInput,
  signal?: AbortSignal,
): Promise<NetworkProviderDumpResult> {
  signal?.throwIfAborted();
  const scope = { stateDir: input.stateDir, session: input.session };
  if (readMetroSessionHints(scope) === undefined) {
    throw new AppError(
      'COMMAND_FAILED',
      'This session has no React Native dev-server binding, so it has no in-app network capture.',
      { reason: 'metro-binding-missing' },
    );
  }
  const serverUrl = resolveSessionMetroServerUrl(scope);
  if (input.appBundleId !== undefined && input.metroDeviceIdentity === undefined) {
    // Without a name that marks exactly one attached device, any same-app runtime could be
    // picked and hooked; the provider does not guess.
    throw new AppError(
      'COMMAND_FAILED',
      'This session device cannot be named unambiguously among the devices attached to this host, so the in-app network capture stays off for it.',
      { reason: 'metro-device-mismatch' },
    );
  }
  const target = selectReactNativeTarget(await listMetroInspectorTargets(serverUrl, signal), {
    appId: input.appBundleId,
    ...(input.metroDeviceIdentity === undefined
      ? {}
      : { metroDeviceIdentity: input.metroDeviceIdentity }),
  });
  const session = await InspectorSession.connect(debuggerUrlOn(serverUrl, target), signal);
  try {
    // The installing dump's payload budget becomes the in-app body cap, so the app-side copy is
    // never larger than what the host would report anyway.
    const installed = await session.evaluate(
      `(${NETWORK_CAPTURE_RUNTIME_SOURCE})(${JSON.stringify(NETWORK_CAPTURE_RUNTIME_VERSION)}, ${NETWORK_CAPTURE_MAX_ENTRIES}, ${input.maxPayloadChars}, ${NETWORK_CAPTURE_HEADER_CHARS})`,
    );
    const drained = readJsonResult(
      await runtimeCall(session, 'drain', String(input.maxEntries)),
      'drain',
    );
    if (drained.ok !== true || !Array.isArray(drained.entries)) {
      throw new AppError('COMMAND_FAILED', 'The app network capture refused to drain.', {
        reason: 'network-capture-drain-refused',
      });
    }
    const entries = projectCapturedNetworkEntries(
      drained.entries,
      input.include,
      input.maxPayloadChars,
    );
    const buffered = readBuffered(await runtimeCall(session, 'stats'));
    const dropped = typeof drained.dropped === 'number' ? drained.dropped : 0;
    const notes = [...captureBufferNotes({ buffered, dropped })];
    if (entries.length === 0) {
      notes.push(
        installed === 'installed'
          ? 'In-app network capture was installed by this dump, so it holds no earlier traffic. Reproduce the requests now, then dump again for method, full URL, status, duration, headers, and bodies.'
          : 'The app runtime captured no request since the last dump.',
      );
    }
    return Object.freeze({
      backend: NETWORK_CAPTURE_BACKEND,
      entries,
      notes: Object.freeze(notes),
      ...(installed === 'installed' && entries.length === 0 ? { armed: true } : {}),
    });
  } finally {
    session.close();
  }
}
