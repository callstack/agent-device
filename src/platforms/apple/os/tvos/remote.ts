import type { RunnerCommand } from '../../core/runner/runner-contract.ts';

// The tvOS Apple-OS leaf (ADR-0009). tvOS has no touch input: it is driven by the
// Siri Remote's focus engine, so back/home/scroll navigate focus via XCUIRemote
// hardware-button presses rather than coordinate taps or drags. This focus-only
// interaction contract is per-OS by design and must NOT be flattened into a uniform
// Apple tap/gesture path (perfect-shape §7; ADR-0009). The `isTvOsDevice` gate
// (kernel/device.ts) selects when this leaf's behavior applies.

export type AppleRemoteButton = NonNullable<RunnerCommand['remoteButton']>;

/**
 * Builds the XCUIRemote `remotePress` runner command for a tvOS navigation intent.
 * Scroll directions map straight onto the directional remote buttons; back maps to
 * `menu` and home to `home`. An optional `durationMs` becomes a button hold.
 */
export function appleRemotePressCommand(
  remoteButton: AppleRemoteButton,
  appBundleId?: string,
  durationMs?: number,
): RunnerCommand {
  return {
    command: 'remotePress',
    remoteButton,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(appBundleId !== undefined ? { appBundleId } : {}),
  };
}
