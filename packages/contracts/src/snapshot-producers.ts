import type { SnapshotRefMinting } from '@agent-device/kernel/snapshot';

// Vocabulary only: the iOS snapshot contract derives its producer subsets from this table with a
// type-only import, so this module holds data and types and no behavior.

/**
 * Every acquisition that can produce a snapshot tree, named for the source and never for the
 * platform: one platform channel can be fed by several producers with different guarantees, and
 * one producer can feed more than one channel (`appium-source` answers for WebDriver iOS and
 * Android). Sharing a parser does not make two sources one producer.
 */
export type SnapshotProducer =
  | 'apple-runner'
  | 'simulator-ax-bridge'
  | 'appium-source'
  | 'revyl-ios-tree'
  | 'revyl-android-tree'
  | 'android-uiautomator'
  | 'cdp-dom'
  | 'harmonyos-uitest'
  | 'macos-helper'
  | 'linux-atspi'
  | 'agent-browser';

export type SnapshotProducerFacts = Readonly<{
  /** The platform channels this producer's trees arrive on: the `backend` of its provenance pairs. */
  channels: readonly [string, ...string[]];
  /**
   * Whether the producer observes truncation at all. On the iOS channel a capture that reported
   * nothing about truncation is only "not truncated" when its producer would have noticed (#2188
   * invariant 5).
   */
  truncation: 'available' | 'unavailable';
  /**
   * `source-measured`: the source builds its own residue. `provider-derived`: a provider hands over a
   * bare tree and nothing else, so capture-kit derives what it leaves unproven. On the iOS channel
   * only a provider-derived producer may build an acquisition through capture-kit; a source-measured
   * one there would be a claim nothing consults (#2199).
   */
  residue: 'source-measured' | 'provider-derived';
  /**
   * The default stable-capture quiet window a capture from this producer earns. The Simulator AX
   * bridge answers well inside the general default, so holding the general window on that read spends
   * a whole extra capture on a window its tree had already satisfied (PR #3522 holds the measurement).
   * Every producer states its price, so a new one cannot inherit an unmeasured window by omission.
   */
  quietMs: number;
  /**
   * `backend-issued`: the producer resolves actions against refs it minted itself, and so owns the
   * ref namespace of every tree it publishes (#2283). A producer that mints nothing keeps dense
   * positional numbering.
   */
  refs: SnapshotRefMinting;
  /**
   * What an iOS interactive snapshot that exposed only the application root says about this producer:
   * an XCTest query that failed to enumerate the tree, an Appium page source that lacked the
   * descendants, or nothing.
   */
  sparseRootWarning: 'xctest-query' | 'appium-page-source' | 'none';
}>;

const GENERAL_QUIET_MS = 500;

/**
 * The one table of producer facts. Every other producer-keyed fact derives from it: the provenance
 * pairs (`snapshot-model.ts`), the iOS producer subsets (`ios-snapshot.ts`), truncation, residue,
 * quiet time, ref minting, and producer warning dispatch. A new producer adds a row here and stamps
 * its served identity through `@agent-device/capture-kit/snapshot-identity`.
 */
export const SNAPSHOT_PRODUCERS = {
  'apple-runner': {
    channels: ['xctest'],
    truncation: 'available',
    residue: 'source-measured',
    quietMs: GENERAL_QUIET_MS,
    refs: 'dense',
    sparseRootWarning: 'xctest-query',
  },
  'simulator-ax-bridge': {
    channels: ['xctest'],
    truncation: 'available',
    residue: 'source-measured',
    quietMs: 300,
    refs: 'dense',
    sparseRootWarning: 'none',
  },
  'appium-source': {
    channels: ['xctest', 'android'],
    truncation: 'unavailable',
    residue: 'provider-derived',
    quietMs: GENERAL_QUIET_MS,
    refs: 'dense',
    sparseRootWarning: 'appium-page-source',
  },
  'revyl-ios-tree': {
    channels: ['xctest'],
    truncation: 'unavailable',
    residue: 'provider-derived',
    quietMs: GENERAL_QUIET_MS,
    refs: 'dense',
    sparseRootWarning: 'none',
  },
  'revyl-android-tree': {
    channels: ['android'],
    truncation: 'unavailable',
    residue: 'provider-derived',
    quietMs: GENERAL_QUIET_MS,
    refs: 'dense',
    sparseRootWarning: 'none',
  },
  'android-uiautomator': {
    channels: ['android'],
    truncation: 'available',
    residue: 'source-measured',
    quietMs: GENERAL_QUIET_MS,
    refs: 'dense',
    sparseRootWarning: 'none',
  },
  'cdp-dom': {
    channels: ['android'],
    truncation: 'available',
    residue: 'source-measured',
    quietMs: GENERAL_QUIET_MS,
    refs: 'dense',
    sparseRootWarning: 'none',
  },
  'harmonyos-uitest': {
    channels: ['harmonyos-arkui'],
    truncation: 'available',
    residue: 'source-measured',
    quietMs: GENERAL_QUIET_MS,
    refs: 'dense',
    sparseRootWarning: 'none',
  },
  'macos-helper': {
    channels: ['macos-helper'],
    truncation: 'available',
    residue: 'source-measured',
    quietMs: GENERAL_QUIET_MS,
    refs: 'dense',
    sparseRootWarning: 'none',
  },
  'linux-atspi': {
    channels: ['linux-atspi'],
    truncation: 'available',
    residue: 'source-measured',
    quietMs: GENERAL_QUIET_MS,
    refs: 'dense',
    sparseRootWarning: 'none',
  },
  'agent-browser': {
    channels: ['web'],
    truncation: 'available',
    residue: 'source-measured',
    quietMs: GENERAL_QUIET_MS,
    refs: 'backend-issued',
    sparseRootWarning: 'none',
  },
} as const satisfies Record<SnapshotProducer, SnapshotProducerFacts>;
