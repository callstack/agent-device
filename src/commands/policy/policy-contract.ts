/**
 * Types shared by the policy provider abstraction, the `suggest` command, and the `act` loop.
 * A policy provider answers one question — which on-screen element advances a goal — and returns
 * a typed decision with calibrated probabilities instead of free-form text.
 */

/** One element a policy may choose between, projected from an interactive snapshot. */
export type PolicyCandidate = {
  /** Snapshot ref, including its leading `@`. */
  ref: string;
  /** Neutral role name (`button`, `textfield`, `switch`, `link`, `key`, `text`). */
  role: string;
  /** Accessibility label, identifier, or node type, in that order of preference. */
  name: string;
  /** Accessibility identifier, when the node carries one. The stable key for input matching. */
  identifier?: string;
  /** Current accessibility value, when the node reports one. */
  value?: string;
  /** True when the node reports itself disabled; disabled nodes stay visible as context. */
  disabled?: boolean;
};

/** What the caller should do with the chosen element. */
export type PolicyActionKind = 'press' | 'fill' | 'none';

/** The decision a provider returns for one screen. */
export type PolicyDecision = {
  action: PolicyActionKind;
  /** Chosen ref, or null when the provider declined to choose. */
  target: string | null;
  /** Provider believes the goal is already satisfied on this screen. */
  done: boolean;
  /** Provider believes progress needs something not on this screen. */
  blocked: boolean;
  /** Chosen target is an empty text field, so the caller must supply text. */
  needsText: boolean;
  /** Provider-reported confidence in the chosen target, 0 to 1. */
  confidence: number;
  /** Probability per candidate ref plus the decline label, 0 to 1. */
  probabilities: Record<string, number>;
  provider: string;
  model: string;
  /** Wall-clock milliseconds spent in the provider call. */
  decideMs: number;
  inputTokens: number;
  costUsd: number;
};

/** Why a step ended the way it did. */
export type PolicyStepOutcome =
  | 'acted'
  | 'done'
  | 'blocked'
  | 'escalated'
  | 'dead-action'
  | 'failed';

/** What the loop did on one step, with the three phase timings kept apart. */
export type PolicyActStep = {
  step: number;
  /** Short human label for the screen the decision was made on. */
  screen: string;
  decision: PolicyDecision;
  outcome: PolicyStepOutcome;
  /** Present when the step performed a device action. */
  performed?: {
    action: PolicyActionKind;
    target: string;
    /** How text reached the field; `keypad` is the digit-field fallback. */
    entry?: 'fill' | 'keypad';
    /** Input map key whose value was sent. The value itself is never recorded. */
    inputKey?: string;
  };
  snapshotMs: number;
  decideMs: number;
  actionMs: number;
  /** Set when the step could not proceed, in the loop's vocabulary. */
  reason?: string;
};

export type PolicyActStatus = 'done' | 'blocked' | 'escalated' | 'max-steps';

export type PolicyActTotals = {
  steps: number;
  snapshotMs: number;
  decideMs: number;
  actionMs: number;
  inputTokens: number;
  costUsd: number;
  deadActions: number;
  escalations: number;
};

export type PolicySuggestResult = {
  goal: string;
  decision: PolicyDecision;
  candidates: PolicyCandidate[];
  snapshotMs: number;
  screen: string;
};

export type PolicyActResult = {
  goal: string;
  status: PolicyActStatus;
  steps: PolicyActStep[];
  totals: PolicyActTotals;
};

/** Everything a provider needs to judge one screen. */
export type PolicyRequest = {
  goal: string;
  candidates: PolicyCandidate[];
  /** What the loop already did, oldest first; empty for a one-shot `suggest`. */
  history: string[];
  /** Short label for the current screen, used as context only. */
  screen: string;
  /**
   * Refs of fields the caller has text ready for. Values are never included: the policy only needs
   * to know the text exists, and without that it reports a code screen as blocked even when the
   * caller supplied the code.
   */
  textReadyRefs: readonly string[];
};

/** A policy head. One implementation ships today: `jev`. */
export type PolicyProvider = {
  readonly name: string;
  readonly model: string;
  decide: (request: PolicyRequest) => Promise<PolicyDecision>;
};
