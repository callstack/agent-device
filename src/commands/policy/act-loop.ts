import {
  findKeypadDigit,
  isTextEntryRole,
  screenDigest,
  screenLabel,
  toPolicyCandidates,
  type PolicySnapshotNode,
} from './candidate-elements.ts';
import type {
  PolicyActResult,
  PolicyActStep,
  PolicyActStatus,
  PolicyCandidate,
  PolicyDecision,
  PolicyProvider,
  PolicyStepOutcome,
} from './policy-contract.ts';
import { resolveTextInput, type PolicyTextInputs, type ResolvedTextInput } from './text-inputs.ts';

/** The three device operations the loop needs, named so a test can supply them directly. */
export type PolicyDevicePort = {
  snapshot: () => Promise<{ nodes: PolicySnapshotNode[]; ms: number }>;
  press: (ref: string) => Promise<number>;
  fill: (ref: string, text: string) => Promise<number>;
};

export type PolicyActOptions = {
  goal: string;
  provider: PolicyProvider;
  device: PolicyDevicePort;
  inputs: PolicyTextInputs;
  env: Readonly<Record<string, string | undefined>>;
  maxSteps: number;
  minConfidence: number;
  /** Called once per completed step so a CLI can stream progress. */
  onStep?: (step: PolicyActStep) => void;
  /** Injected so a test never waits out the grace re-read. */
  sleep?: (ms: number) => Promise<void>;
};

export const DEFAULT_POLICY_MAX_STEPS = 12;
export const DEFAULT_POLICY_MIN_CONFIDENCE = 0.4;

/**
 * A provider that reports `blocked` while also naming a concrete target at very high confidence is
 * describing the screen, not the goal: an unauthenticated sign-in screen is literally a login wall,
 * and every credential it needs is on it. Acting on that target is what keeps the loop from
 * stalling on step one of any sign-in flow. Below this confidence the flag is taken at face value.
 */
const ACT_DESPITE_BLOCKED_CONFIDENCE = 0.9;

/** Consecutive unproductive steps tolerated before the loop hands back. */
const ESCALATION_LIMIT = 3;

/** How long to wait before re-reading a screen that has not changed yet. */
const TRANSITION_GRACE_MS = 800;

/** The per-step inputs a step decision and action both read. */
type StepContext = {
  decision: PolicyDecision;
  candidates: PolicyCandidate[];
  digestBefore: string;
  history: string[];
};

/** What one step concluded, before the loop turns it into a recorded step. */
type StepResult = { outcome: PolicyStepOutcome; extra?: Partial<PolicyActStep> };

export async function runPolicyActLoop(options: PolicyActOptions): Promise<PolicyActResult> {
  const steps: PolicyActStep[] = [];
  const history: string[] = [];
  let status: PolicyActStatus = 'max-steps';
  let unproductive = 0;

  for (let index = 0; index < options.maxSteps; index++) {
    const before = await options.device.snapshot();
    const candidates = toPolicyCandidates(before.nodes);
    const screen = screenLabel(candidates);
    const context: StepContext = {
      decision: await options.provider.decide({
        goal: options.goal,
        candidates,
        // Copied, not shared: a provider that holds the request must not observe later steps.
        history: [...history],
        screen,
        textReadyRefs: textReadyRefs(candidates, options.inputs, options.env),
      }),
      candidates,
      digestBefore: screenDigest(candidates),
      history,
    };

    const result = await resolveStep(options, context);
    const step: PolicyActStep = {
      step: index + 1,
      screen,
      decision: context.decision,
      outcome: result.outcome,
      snapshotMs: before.ms,
      decideMs: context.decision.decideMs,
      actionMs: 0,
      ...result.extra,
    };
    steps.push(step);
    options.onStep?.(step);

    unproductive = result.outcome === 'acted' ? 0 : unproductive + 1;
    const ended = endStatus(result.outcome, unproductive);
    if (ended) {
      status = ended;
      break;
    }
  }

  return { goal: options.goal, status, steps, totals: totalsFor(steps) };
}

/** The status a run ends with after this outcome, or undefined to keep going. */
function endStatus(outcome: PolicyStepOutcome, unproductive: number): PolicyActStatus | undefined {
  if (outcome === 'done') return 'done';
  if (outcome === 'blocked') return 'blocked';
  return unproductive >= ESCALATION_LIMIT ? 'escalated' : undefined;
}

/** Judge the decision, and act on it when it is actionable. */
async function resolveStep(options: PolicyActOptions, context: StepContext): Promise<StepResult> {
  if (context.decision.done) return { outcome: 'done' };

  const halt = haltReason(context.decision, options.minConfidence);
  if (halt) return { outcome: halt.outcome, extra: { reason: halt.reason } };

  const target = context.decision.target as string;
  const candidate = context.candidates.find((entry) => entry.ref === target);
  const textEntry = resolveTextEntry(candidate, options.inputs, options.env);

  if (textEntry.kind === 'unsupplied') {
    return {
      outcome: 'escalated',
      extra: {
        reason: `no text supplied for ${candidate?.identifier ?? candidate?.name ?? target}`,
      },
    };
  }
  if (textEntry.kind === 'write') {
    return await writeStep(options, context, target, candidate, textEntry.input);
  }
  return await pressStep(options, context, target, candidate);
}

async function writeStep(
  options: PolicyActOptions,
  context: StepContext,
  target: string,
  candidate: PolicyCandidate | undefined,
  input: ResolvedTextInput,
): Promise<StepResult> {
  const name = candidate?.name ?? target;
  const filled = await enterText(options.device, target, input.text, candidate);
  // A digit-box widget never reflects its value, so a confirmed value is sufficient evidence but
  // not necessary: a screen that moved on is the other half of it.
  const landed = filled.valueConfirmed || (await screenChanged(options, context.digestBefore));
  context.history.push(
    landed ? `filled ${name} from input ${input.key}` : `could not write into ${name}`,
  );
  const reason = `the field did not take the supplied text (${filled.failure ?? 'value unchanged'})`;
  return {
    outcome: landed ? 'acted' : 'dead-action',
    extra: {
      actionMs: filled.ms,
      performed: { action: 'fill', target, entry: filled.entry, inputKey: input.key },
      ...(landed ? {} : { reason }),
    },
  };
}

async function pressStep(
  options: PolicyActOptions,
  context: StepContext,
  target: string,
  candidate: PolicyCandidate | undefined,
): Promise<StepResult> {
  const actionMs = await options.device.press(target);
  context.history.push(`pressed ${candidate?.name ?? target}`);
  const changed = await screenChanged(options, context.digestBefore);
  return {
    outcome: changed ? 'acted' : 'dead-action',
    extra: {
      actionMs,
      performed: { action: 'press', target },
      ...(changed ? {} : { reason: 'screen unchanged after press' }),
    },
  };
}

/** Refs of text fields the caller has text for that is not already in them. */
function textReadyRefs(
  candidates: readonly PolicyCandidate[],
  inputs: PolicyTextInputs,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return candidates
    .filter((candidate) => resolveTextEntry(candidate, inputs, env).kind === 'write')
    .map((candidate) => candidate.ref);
}

/**
 * Whether the screen moved on from the digest taken before the action.
 *
 * A settled observation only proves the local UI went quiet. A transition waiting on the network —
 * request a code, verify a code — lands after that, so an immediate read still shows the old
 * screen and a real action would be filed as dead. One grace re-read separates a slow transition
 * from an action that genuinely did nothing.
 */
async function screenChanged(
  options: Pick<PolicyActOptions, 'device' | 'sleep'>,
  digestBefore: string,
): Promise<boolean> {
  const digestOf = (nodes: PolicySnapshotNode[]): string => screenDigest(toPolicyCandidates(nodes));
  const immediate = await options.device.snapshot();
  if (digestOf(immediate.nodes) !== digestBefore) return true;
  await (options.sleep ?? defaultSleep)(TRANSITION_GRACE_MS);
  const settled = await options.device.snapshot();
  return digestOf(settled.nodes) !== digestBefore;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decide whether the chosen element needs text written into it.
 *
 * `press` on a text field only focuses it, so the question is not whether the field is empty but
 * whether the caller named text for it that is not already there. A field carrying a development
 * default the caller overrode has to be rewritten, and a field already holding the supplied value
 * must not be rewritten, or the loop would spend its whole budget refilling one field.
 */
function resolveTextEntry(
  candidate: PolicyCandidate | undefined,
  inputs: PolicyTextInputs,
  env: Readonly<Record<string, string | undefined>>,
): { kind: 'press' } | { kind: 'write'; input: ResolvedTextInput } | { kind: 'unsupplied' } {
  if (!candidate || !isTextEntryRole(candidate.role)) return { kind: 'press' };
  const input = resolveTextInput(candidate, inputs, env);
  if (!input) return candidate.value ? { kind: 'press' } : { kind: 'unsupplied' };
  return sameText(candidate.value, input.text) ? { kind: 'press' } : { kind: 'write', input };
}

/** Compares a field value with supplied text ignoring the formatting a field applies itself. */
function sameText(value: string | undefined, text: string): boolean {
  const normalize = (input: string): string => input.replaceAll(/[^a-z0-9]/giu, '').toLowerCase();
  if (value === undefined) return false;
  const current = normalize(value);
  const wanted = normalize(text);
  return current === wanted || (wanted.length > 0 && current.endsWith(wanted));
}

function haltReason(
  decision: PolicyDecision,
  minConfidence: number,
): { outcome: 'blocked' | 'escalated'; reason: string } | undefined {
  if (decision.target === null) {
    return { outcome: 'escalated', reason: 'policy chose no element on this screen' };
  }
  if (decision.blocked && decision.confidence < ACT_DESPITE_BLOCKED_CONFIDENCE) {
    return { outcome: 'blocked', reason: 'policy reports progress blocked on this screen' };
  }
  if (decision.confidence < minConfidence) {
    return {
      outcome: 'escalated',
      reason: `confidence ${decision.confidence.toFixed(2)} below --min-confidence ${minConfidence}`,
    };
  }
  return undefined;
}

/**
 * Write text into a field, then verify from the screen that it arrived.
 *
 * Two device realities make the write itself an unreliable signal.
 *
 * A field with an input mask reformats what it receives, so the runner's own text-entry
 * verification reports `TEXT_ENTRY_MISMATCH` comparing "5005550700" against "(500) 555-0700". The
 * text did arrive. Keyed on that typed code, the loop re-reads the field and decides from the value
 * rather than from the comparison.
 *
 * A code or PIN field is often a row of single-character boxes over a hidden input: the write
 * succeeds, the accessibility value never changes, and the submit button stays disabled. When the
 * text is all digits, the on-screen keypad is the only path that registers them, one key press at a
 * time, each needing a fresh snapshot because refs are reissued after every press.
 */
async function enterText(
  device: PolicyDevicePort,
  ref: string,
  text: string,
  candidate: PolicyCandidate | undefined,
): Promise<{ ms: number; entry: 'fill' | 'keypad'; valueConfirmed: boolean; failure?: string }> {
  const startedAt = Date.now();
  const failure = await writeFailure(device, ref, text);
  const filledMs = Date.now() - startedAt;

  // The write's own verdict is not the evidence; the field's value is. Both realities above report
  // failure on a write that arrived, and one reports success on a write that did not.
  const verification = await device.snapshot();
  if (valueLanded(verification.nodes, candidate, text)) {
    return { ms: filledMs, entry: 'fill', valueConfirmed: true };
  }

  const digits = text.replaceAll(/\D/gu, '');
  if (digits.length !== text.length || digits.length === 0) {
    return { ms: filledMs, entry: 'fill', valueConfirmed: false, ...(failure ? { failure } : {}) };
  }

  const keypad = await enterDigitsOnKeypad(device, digits);
  return {
    ms: filledMs + keypad.ms,
    entry: keypad.entered > 0 ? 'keypad' : 'fill',
    valueConfirmed: keypad.entered === digits.length,
    ...(failure ? { failure } : {}),
  };
}

/** Tap each digit on the on-screen keypad, re-reading because refs are reissued per press. */
async function enterDigitsOnKeypad(
  device: PolicyDevicePort,
  digits: string,
): Promise<{ ms: number; entered: number }> {
  let ms = 0;
  let entered = 0;
  for (const digit of digits) {
    const snapshot = await device.snapshot();
    const key = findKeypadDigit(snapshot.nodes, digit);
    if (!key?.ref) break;
    ms += await device.press(key.ref.startsWith('@') ? key.ref : `@${key.ref}`);
    entered++;
  }
  return { ms, entered };
}

/**
 * Attempt the write and report its typed failure rather than raising it.
 *
 * A masked field reports `TEXT_ENTRY_MISMATCH` on text that did arrive, and a custom digit-box
 * widget can make the runner record a failure whose documented recovery is a fresh snapshot — which
 * is the next thing this path does. Either way the screen decides, so the write's verdict is
 * carried as evidence instead of ending the run.
 */
async function writeFailure(
  device: PolicyDevicePort,
  ref: string,
  text: string,
): Promise<string | undefined> {
  try {
    await device.fill(ref, text);
    return undefined;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : 'the write did not complete';
  }
}

function valueLanded(
  nodes: readonly PolicySnapshotNode[],
  candidate: PolicyCandidate | undefined,
  text: string,
): boolean {
  const node = nodes.find((entry) =>
    candidate?.identifier
      ? entry.identifier === candidate.identifier
      : entry.label === candidate?.name,
  );
  return sameText(node?.value, text);
}

function totalsFor(steps: readonly PolicyActStep[]): PolicyActResult['totals'] {
  return {
    steps: steps.length,
    snapshotMs: sum(steps, (step) => step.snapshotMs),
    decideMs: sum(steps, (step) => step.decideMs),
    actionMs: sum(steps, (step) => step.actionMs),
    inputTokens: sum(steps, (step) => step.decision.inputTokens),
    costUsd: sum(steps, (step) => step.decision.costUsd),
    deadActions: steps.filter((step) => step.outcome === 'dead-action').length,
    escalations: steps.filter((step) => step.outcome === 'escalated').length,
  };
}

function sum(steps: readonly PolicyActStep[], read: (step: PolicyActStep) => number): number {
  return steps.reduce((total, step) => total + read(step), 0);
}
