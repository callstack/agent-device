import {
  SNAPSHOT_PRODUCERS,
  type SnapshotProducer,
  type SnapshotProducerFacts,
} from './snapshot-producers.ts';
import type {
  IosTargetActivation,
  PresentedSurface,
  SnapshotKeyboardBandFact,
  SnapshotNode,
  SnapshotPresentation,
  SnapshotQualityNote,
  SnapshotQualityVerdict,
  SnapshotRefMinting,
  SnapshotViewportSize,
} from '@agent-device/kernel/snapshot';

/**
 * The registry row of a producer read from a capture. A store plugin built against another release
 * can name a producer this host does not list; that capture gets no producer facts.
 */
export function snapshotProducerFacts(
  producer: SnapshotProducer,
): SnapshotProducerFacts | undefined {
  return Object.hasOwn(SNAPSHOT_PRODUCERS, producer) ? SNAPSHOT_PRODUCERS[producer] : undefined;
}

type ProducerChannel<Producer extends SnapshotProducer> =
  (typeof SNAPSHOT_PRODUCERS)[Producer]['channels'][number];

export type SnapshotBackend = ProducerChannel<SnapshotProducer>;

type ProducerOnChannel<Backend extends SnapshotBackend> = {
  [Producer in SnapshotProducer]: Backend extends ProducerChannel<Producer> ? Producer : never;
}[SnapshotProducer];

/**
 * The channel↔producer pairs that can actually occur, derived from {@link SNAPSHOT_PRODUCERS}.
 * `xctest` trees come from the local Apple runner, the Simulator AX bridge, Appium page-source XML,
 * or a cloud provider's AX element tree (Revyl), and only the runner's output has been through its
 * presentation (clip fold, effective geometry, scope). Logic that assumes those guarantees must key
 * on the producer, never on the channel alone.
 *
 * Every carrier embeds the pair atomically, so a cross-channel pair does not compile.
 */
export type SnapshotProvenance = {
  [Backend in SnapshotBackend]: { backend: Backend; producer: ProducerOnChannel<Backend> };
}[SnapshotBackend];

type OptionalProducerProvenance<Pair> = Pair extends {
  backend: infer Backend;
  producer: infer Producer;
}
  ? { backend: Backend; producer?: Producer }
  : never;

/**
 * The provenance carrier for {@link SnapshotState}: the producer may be absent (a client-side
 * fallback that rebuilds a state from a bare backend result knows the channel and nothing more),
 * but a present pair still has to come from the {@link SnapshotProvenance} table — the channel
 * may not carry a foreign producer.
 */
export type SnapshotStateProvenance =
  | OptionalProducerProvenance<SnapshotProvenance>
  | { backend?: undefined; producer?: undefined };

/**
 * The provenance a capture hands to the daemon snapshot assembly: either nothing is known about
 * the origin, or the WHOLE pair is. A channel that arrived without its producer would leave the
 * assembly guessing who presented the tree, which is exactly the backend-name presentation
 * policy #2199 deleted — so it does not compile. Every production capture satisfies this: the
 * interactor boundary (`SnapshotResult`) already carries {@link SnapshotProvenance}.
 */
export type SnapshotCaptureProvenance =
  | SnapshotProvenance
  | { backend?: undefined; producer?: undefined };

/**
 * Narrows a provenance-carrying value to just its pair without decorrelating the two fields
 * (reading `backend` and `producer` separately would lose the pairing for the type system).
 */
export function snapshotStateProvenance(
  value: SnapshotStateProvenance | undefined,
): SnapshotStateProvenance {
  if (value === undefined || value.backend === undefined) return {};
  switch (value.backend) {
    case 'xctest':
      return { backend: value.backend, producer: value.producer };
    case 'android':
      return { backend: value.backend, producer: value.producer };
    case 'harmonyos-arkui':
      return { backend: value.backend, producer: value.producer };
    case 'macos-helper':
      return { backend: value.backend, producer: value.producer };
    case 'linux-atspi':
      return { backend: value.backend, producer: value.producer };
    case 'web':
      return { backend: value.backend, producer: value.producer };
  }
}

const SNAPSHOT_BACKENDS: ReadonlySet<string> = new Set(
  Object.values(SNAPSHOT_PRODUCERS).flatMap((facts) => facts.channels),
);

export function isSnapshotBackend(value: unknown): value is SnapshotBackend {
  return typeof value === 'string' && SNAPSHOT_BACKENDS.has(value);
}

export function usesMobileSnapshotPresentation(backend: SnapshotBackend | undefined): boolean {
  return (
    backend === undefined ||
    backend === 'xctest' ||
    backend === 'android' ||
    backend === 'harmonyos-arkui'
  );
}

export type SnapshotState = {
  nodes: SnapshotNode[];
  createdAt: number;
  truncated?: boolean;
  snapshotQuality?: SnapshotQualityVerdict;
  snapshotQualityNotes?: SnapshotQualityNote[];
  comparisonSafe?: boolean;
  presentationKey?: string;
  /** The presentation this capture was taken with; absent means the default full tree. */
  presentation?: SnapshotPresentation;
  /** Opaque equality key for iOS acquisition and presentation lineage. */
  comparisonKey?: string;
  /**
   * Android: the capture is an occluding system surface (notification shade, quick settings)
   * rather than app content. Consumers that surface this tree to the agent must disclose the
   * occlusion (see `@agent-device/contracts/android-system-surface-disclosure`).
   */
  systemSurfaceOnly?: boolean;
  /**
   * iOS: the bundle id of the in-place system surface this capture describes (a web sign-in sheet
   * presented over the app, #2438). Two captures that disagree here describe different surfaces and
   * must never be compared as the same presentation; consumers that surface the tree disclose it.
   */
  iosSystemSurfaceBundleId?: string;
  /**
   * iOS: whether this capture read a modal presentation over the app's own content (#3565), decided
   * on the acquired tree before interactive filtering, compaction, depth, or scope, so every view of
   * one screen carries one value. `'absent'` is read, never defaulted; an unreadable or unexplained
   * capture answers `'unknown'`. Settle's presented-surface confirmation arms on this fact.
   */
  presentedSurface?: PresentedSurface;
  /**
   * iOS and Android: keyboard observations made during acquisition. Measured and derived frames
   * take precedence over reconstruction from the presented tree. Visibility-only and unknown facts
   * carry no band; missing nodes or an omitted fact never establish absence.
   */
  keyboard?: SnapshotKeyboardBandFact;
  /**
   * The box these rects are measured in, as the producer measured it (#3182). The state is the carrier
   * the response reads, so the stored tree and the published `viewport` are one fact rather than two:
   * a consumer of a stored capture — a later diff, a re-read of the session's tree — gets the box the
   * producer measured instead of inferring one from the largest rect still on screen.
   */
  viewport?: SnapshotViewportSize;
  /**
   * iOS: this capture's own command found the session app out of foreground and the runner
   * activated it before answering, so an earlier observation in the session described whatever held
   * the foreground instead (#2682). Consumers that surface this tree disclose the repair.
   */
  targetActivation?: IosTargetActivation;
  /** What post-gesture stabilization proved about the gesture before this capture. */
  postGestureOutcome?: PostGestureOutcome;
} & SnapshotStateProvenance;

/** The gesture a post-gesture outcome fact names: the command and its positionals. */
export type PostGestureAction = { action: string; positionals: string[] };

/**
 * `unsettled`: the surface was still changing when the stabilization deadline expired.
 * `no-effect`: the settled surface still matches the pre-gesture tree (#1600).
 */
export type PostGestureOutcome = {
  kind: 'unsettled' | 'no-effect';
  gesture: PostGestureAction;
};

/**
 * A capture taken at once to recover or widen `previous` reads the same moment after the same
 * gesture, so it carries that capture's outcome.
 */
export function inheritPostGestureOutcome<T extends SnapshotState>(
  previous: SnapshotState,
  recapture: T,
): T {
  recapture.postGestureOutcome ??= previous.postGestureOutcome;
  return recapture;
}

/**
 * The ref-minting mode of a capture, from the pair that produced it. The projection that publishes a
 * tree and the projection that later re-attaches refs to it both read it here, so they cannot
 * disagree about which producers own their ref namespace.
 *
 * It reads the producer and not the platform channel, per the rule the provenance table states:
 * several producers can feed one channel with different guarantees, and a second web adapter
 * (webdriver-backed, or anything else that lands on this channel) mints no refs of its own — it
 * needs dense numbering, which a channel-keyed check would silently take away from it. The
 * parameter is the whole pair or nothing, so a caller cannot present a channel and leave this to
 * guess who acquired the tree.
 */
export function snapshotRefMinting(
  provenance: SnapshotCaptureProvenance | undefined,
): SnapshotRefMinting {
  const producer = provenance?.producer;
  return producer === undefined ? 'dense' : (snapshotProducerFacts(producer)?.refs ?? 'dense');
}

export function buildSnapshotNodeMap<T extends { index: number }>(
  nodes: readonly T[],
): Map<number, T> {
  return new Map(nodes.map((node) => [node.index, node]));
}

/**
 * Walks from the given node through its parent chain and returns the first
 * non-null value produced by `resolve`. Returning null from `resolve` skips
 * that ancestor and continues walking toward the root. Parents are resolved
 * by snapshot index (not array position) with an array-offset fallback, and
 * a visited set guards against parent-linkage cycles.
 */
export function findSnapshotAncestor<T>(
  nodes: SnapshotNode[],
  node: SnapshotNode,
  nodeByIndex: ReadonlyMap<number, SnapshotNode>,
  resolve: (ancestor: SnapshotNode) => T | null,
): T | null {
  let current: SnapshotNode | undefined = node;
  const visited = new Set<number>();
  while (typeof current.parentIndex === 'number' && !visited.has(current.index)) {
    visited.add(current.index);
    current = nodeByIndex.get(current.parentIndex) ?? nodes[current.parentIndex];
    if (!current) return null;
    const result = resolve(current);
    if (result !== null) return result;
  }
  return null;
}

/** Returns the nearest ancestor matching `predicate`; false means keep walking. */
export function findNearestAncestor(
  nodes: SnapshotNode[],
  node: SnapshotNode,
  predicate: (ancestor: SnapshotNode) => boolean,
): SnapshotNode | null {
  return findSnapshotAncestor(nodes, node, buildSnapshotNodeMap(nodes), (ancestor) =>
    predicate(ancestor) ? ancestor : null,
  );
}
