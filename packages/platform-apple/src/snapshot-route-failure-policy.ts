import {
  IOS_SYSTEM_SURFACE_HOSTS,
  type IosSystemSurfaceHost,
} from '@agent-device/contracts/ios-system-surface';
import type { SnapshotSourceFailure } from './snapshot-source-facade.ts';

/**
 * What the screen showed when a capture-scoped bridge refusal fired: a preparation still running
 * (#2491), a runner-served read still running, a tree that changed between two reads, an unresolved coordinate space (#2612), a foreground
 * another surface owns (#3874), or a window that does not fill the screen (#3844). The route consumes one disposition for both
 * decisions that must agree: whether the generation's bridge circuit opens, and which sentence the
 * fallback warning carries (#3874, #3895).
 */
export type CaptureScopedConsequence =
  | 'bridge-preparation'
  | 'bridge-read-busy'
  | 'coordinate-space-unresolved'
  | 'foreground-ownership'
  | 'tree-changed'
  | 'window-not-full-screen';

/**
 * What a surface host refusal names (#2751): the registered host whose process runs for the
 * Simulator, or `unverified` when the guest could not read the process table or place a process.
 */
export type SurfaceHostRefusal = IosSystemSurfaceHost | 'unverified';

/**
 * The one classification a bridge failure receives before the route acts on it. `code` travels
 * unchanged for diagnostics; the scope identifies the capture, generation, or runner session, and a
 * capture-scoped verdict must name what it saw instead. A surface host refusal names the host, and
 * the route serves it from the runner before any fallback warning applies.
 */
export type BridgeFailureDisposition =
  | Readonly<{ scope: 'capture'; code: string; consequence: CaptureScopedConsequence }>
  | Readonly<{
      scope: 'capture';
      code: string;
      consequence: 'system-surface-host';
      surfaceHost: SurfaceHostRefusal;
    }>
  | Readonly<{ scope: 'generation' | 'runner-session'; code: string }>;

/** Every disposition that reaches the generic fallback: all but a surface host refusal. */
export type BridgeFallbackDisposition = Exclude<
  BridgeFailureDisposition,
  Readonly<{ consequence: 'system-surface-host' }>
>;

/**
 * Screen evidence, not app evidence: the arrangement is gone after the next keystroke, tap, or
 * resize, so retiring the generation would move every later capture of a healthy app to the runner.
 * A new capture-scoped refusal enters here, by an explicit decision; the route's warning switch is
 * exhaustive over the consequence, so a new one cannot reach the warning path undefined.
 * `contracts/fixtures/ios-snapshot-bridge-refusals.json` lists every emitted code with its scope, and
 * `test/repo-guards/snapshot-bridge-refusals.test.ts` fails when this table and the emitters disagree.
 */
const CAPTURE_SCOPED_REFUSALS: ReadonlyMap<string, CaptureScopedConsequence> = new Map([
  ['window-coordinate-space-unresolved', 'coordinate-space-unresolved'],
  ['app-window-not-full-screen', 'window-not-full-screen'],
  ['foreground-owner-unverified', 'foreground-ownership'],
  ['foreground-owner-changed', 'foreground-ownership'],
  // The runner-served reader runs one read at a time: the refusal says only that another read, such
  // as one a cancelled capture left running, has not returned yet.
  ['bridge-read-in-flight', 'bridge-read-busy'],
  // A continuation re-read found fewer children than the first read reported: the tree changed
  // between the two reads, as a list does while it scrolls and recycles its cells.
  ['snapshot-tree-changed', 'tree-changed'],
]);

const RUNNER_SESSION_SCOPED: ReadonlySet<string> = new Set(['bridge-reader-wedged']);

/**
 * Whether a bridge failure is evidence that this app generation cannot be served by the bridge.
 * Preparation and screen refusals speak for this capture; a wedged reader retires its runner
 * session. Other failures retire the generation. That default is conservative on purpose: `code` is an open string from
 * the guest, and an unknown code must not quietly keep a generation on a path that just refused
 * it. Do not widen the default; classify a new known refusal in the table.
 */
export function bridgeFailureDisposition(failure: SnapshotSourceFailure): BridgeFailureDisposition {
  if (RUNNER_SESSION_SCOPED.has(failure.code)) {
    return { scope: 'runner-session', code: failure.code };
  }
  if (failure.kind === 'preparing') {
    return { scope: 'capture', code: failure.code, consequence: 'bridge-preparation' };
  }
  const surfaceHost = surfaceHostRefusal(failure);
  if (surfaceHost) {
    return {
      scope: 'capture',
      code: failure.code,
      consequence: 'system-surface-host',
      surfaceHost,
    };
  }
  const consequence = CAPTURE_SCOPED_REFUSALS.get(failure.code);
  if (consequence) {
    return { scope: 'capture', code: failure.code, consequence };
  }
  return { scope: 'generation', code: failure.code };
}

/**
 * A refusal over a running registered host names that host. A present refusal naming no
 * registered executable proves nothing about which surface is up, so it is `unverified`.
 */
function surfaceHostRefusal(failure: SnapshotSourceFailure): SurfaceHostRefusal | undefined {
  if (failure.code === 'system-surface-host-unverified') return 'unverified';
  if (failure.code !== 'system-surface-host-present') return undefined;
  const executable = failure.details?.surfaceHostExecutable;
  return (
    IOS_SYSTEM_SURFACE_HOSTS.find((host) => host.processExecutable === executable) ?? 'unverified'
  );
}
