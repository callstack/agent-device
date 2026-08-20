import type {
  CaptureSnapshotInput,
  FindSelectorInput,
  FindSelectorResult,
  FindTextInput,
  FindTextResult,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
import {
  bindLocalSnapshotInteractor,
  captureSnapshotSignal,
} from '@agent-device/contracts/platform';
import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';

/** Apple-owned selection between app snapshots and explicit macOS surface snapshots. */
export function bindAppleSnapshotRuntime(
  host: PlatformRuntimeHost,
  request: Readonly<{ device: DeviceInfo; signal: AbortSignal }>,
): SnapshotRuntimeOperation {
  const appSnapshot = bindLocalSnapshotInteractor({
    device: request.device,
    signal: request.signal,
    resolveInteractor: host.localInteractors.resolve,
  });
  const captureSnapshot = async (input: CaptureSnapshotInput) => {
    if (
      isMacOs(request.device) &&
      input.options?.surface !== undefined &&
      input.options.surface !== 'app'
    ) {
      return await host.snapshot.captureSurface(
        request.device,
        input.options,
        captureSnapshotSignal(request.signal, input),
      );
    }
    return await appSnapshot.captureSnapshot(input);
  };
  return Object.freeze({
    captureSnapshot,
    captureSnapshotWithCustomActions: captureSnapshot,
    captureSnapshotWithoutActiveApp: captureSnapshot,
  });
}

type SnapshotRuntimeOperation = Pick<
  PlatformRuntimeOperations,
  'captureSnapshot' | 'captureSnapshotWithCustomActions' | 'captureSnapshotWithoutActiveApp'
>;

/**
 * The runner's native text reading. Every condition under which Apple cannot answer lives here
 * rather than in the daemon, which is the point of the migration: no caller inspects the family,
 * the surface, or the session to decide whether to consult it.
 *
 * - No tracked app bundle id: the runner query is scoped to an application, so there is nothing
 *   to ask about.
 * - macOS on an explicit non-app surface: the runner reads the *application*, so a positive
 *   answer would describe the wrong surface. Reporting `false` sends the poll to the desktop
 *   surface capture, which is the reading that matches the request.
 *
 * Both report `found: false` — "not proven here" — never an error, so the caller's canonical tree
 * remains the complete path (ADR 0019 section 2).
 */
export function bindAppleFindTextRuntime(
  host: PlatformRuntimeHost,
  request: Readonly<{ device: DeviceInfo; signal: AbortSignal }>,
): Pick<PlatformRuntimeOperations, 'findText'> {
  return Object.freeze({
    findText: async (input: FindTextInput): Promise<FindTextResult> => {
      const appBundleId = input.options?.appBundleId;
      if (appBundleId === undefined) return { found: false };
      if (isMacOs(request.device) && input.options?.surface !== undefined) {
        if (input.options.surface !== 'app') return { found: false };
      }
      const signal =
        input.signal === undefined
          ? request.signal
          : AbortSignal.any([request.signal, input.signal]);
      signal.throwIfAborted();
      const interactor = await host.localInteractors.resolve(request.device, {
        ...input.execution,
        appBundleId,
        signal,
      });
      if (!interactor.findText) return { found: false };
      return await interactor.findText(input.text, { appBundleId, signal });
    },
  });
}

/** Apple owns the native simple-selector observation; callers never inspect Apple/provider state. */
export function bindAppleFindSelectorRuntime(
  host: PlatformRuntimeHost,
  request: Readonly<{ device: DeviceInfo; signal: AbortSignal }>,
): Pick<PlatformRuntimeOperations, 'findSelector'> {
  return Object.freeze({
    findSelector: async (input: FindSelectorInput): Promise<FindSelectorResult> => {
      const appBundleId = input.options?.appBundleId;
      if (appBundleId === undefined) return { found: false };
      if (
        isMacOs(request.device) &&
        input.options?.surface !== undefined &&
        input.options.surface !== 'app'
      ) {
        return { found: false };
      }
      const signal = input.signal
        ? AbortSignal.any([request.signal, input.signal])
        : request.signal;
      signal.throwIfAborted();
      const interactor = await host.localInteractors.resolve(request.device, {
        ...input.execution,
        appBundleId,
        signal,
      });
      if (!interactor.findSelector) return { found: false };
      return await interactor.findSelector(input.selector, { appBundleId, signal });
    },
  });
}
