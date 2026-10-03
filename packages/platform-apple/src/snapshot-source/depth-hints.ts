import type { SnapshotBridgeRecovery } from './protocol.ts';
import type { SnapshotSourceTarget } from './types.ts';

/**
 * Hinted captures allowed before the owner probes the full requested depth again. A hint is not
 * renewed by captures that merely succeed at the hinted depth, so a screen that regains deep
 * capture ability is rediscovered by the probe rather than capped forever.
 */
export const DEPTH_HINT_PROBE_BACK_AFTER_USES = 8;
const MAX_TRACKED_TARGETS = 32;

export type DepthHintReason =
  | 'hinted'
  | 'probe-back'
  | 'no-hint'
  | 'explicit-depth'
  | 'unidentified-target';

export type DepthHintDecision = Readonly<{
  nativeLevels: number | undefined;
  reason: DepthHintReason;
}>;

export type DepthHintLearning = 'learned' | 'forgotten' | 'kept' | 'ignored';

type HintEntry = {
  generation: string;
  nativeLevels: number;
  remainingUses: number;
};

type HintTarget = Pick<SnapshotSourceTarget, 'targetId' | 'generation'>;

/**
 * Accepted native depth per resolved app generation for one producer. A hint only changes which
 * native levels the first request asks for; the guest still delivers the requested traversal depth
 * through continuations. Hints never cross apps, generations, or producers, and are learned only
 * from a recovery that observed a rejection and then finished: the delivered tree may still be
 * bounded by the requested depth or node budget, which is not a recovery failure.
 */
export class AcceptedDepthHints {
  private readonly entries = new Map<string, HintEntry>();
  private readonly probeBackAfterUses: number;

  constructor(probeBackAfterUses = DEPTH_HINT_PROBE_BACK_AFTER_USES) {
    this.probeBackAfterUses = probeBackAfterUses;
  }

  consume(target: HintTarget, requestedLevels: number, explicitDepth: boolean): DepthHintDecision {
    if (explicitDepth) return { nativeLevels: undefined, reason: 'explicit-depth' };
    const entry = this.currentEntry(target);
    if (entry === 'unidentified') return { nativeLevels: undefined, reason: 'unidentified-target' };
    if (!entry || entry.nativeLevels >= requestedLevels) {
      return { nativeLevels: undefined, reason: 'no-hint' };
    }
    if (entry.remainingUses <= 0) return { nativeLevels: undefined, reason: 'probe-back' };
    entry.remainingUses -= 1;
    return { nativeLevels: entry.nativeLevels, reason: 'hinted' };
  }

  learn(
    target: HintTarget,
    requestedLevels: number,
    explicitDepth: boolean,
    recovery: SnapshotBridgeRecovery,
  ): DepthHintLearning {
    if (explicitDepth || !target.targetId) return 'ignored';
    const recoveredLower = recovery.rejected > 0 && recovery.acceptedLevels < requestedLevels;
    if (recoveredLower) {
      this.remember(target.targetId, {
        generation: target.generation,
        nativeLevels: recovery.acceptedLevels,
        remainingUses: this.probeBackAfterUses,
      });
      return 'learned';
    }
    const acceptedFullDepth = recovery.rejected === 0 && recovery.acceptedLevels >= requestedLevels;
    if (acceptedFullDepth) {
      return this.entries.delete(target.targetId) ? 'forgotten' : 'ignored';
    }
    return this.currentEntry(target) ? 'kept' : 'ignored';
  }

  private currentEntry(target: HintTarget): HintEntry | undefined | 'unidentified' {
    if (!target.targetId) return 'unidentified';
    const entry = this.entries.get(target.targetId);
    if (!entry) return undefined;
    if (entry.generation !== target.generation) {
      this.entries.delete(target.targetId);
      return undefined;
    }
    return entry;
  }

  private remember(targetId: string, entry: HintEntry): void {
    this.entries.delete(targetId);
    if (this.entries.size >= MAX_TRACKED_TARGETS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(targetId, entry);
  }
}
