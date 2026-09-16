import type {
  AgentDeviceRequestOverrides,
  AgentDeviceSelectionOptions,
} from '@agent-device/contracts/client';
import {
  DEFAULT_POLICY_MAX_STEPS,
  DEFAULT_POLICY_MIN_CONFIDENCE,
  runPolicyActLoop,
  type PolicyDevicePort,
} from '../commands/policy/act-loop.ts';
import {
  screenLabel,
  toPolicyCandidates,
  type PolicySnapshotNode,
} from '../commands/policy/candidate-elements.ts';
import type {
  PolicyActResult,
  PolicyActStep,
  PolicySuggestResult,
} from '../commands/policy/policy-contract.ts';
import {
  createPolicyProvider,
  DEFAULT_POLICY_PROVIDER,
} from '../commands/policy/policy-provider.ts';
import { parsePolicyTextInputs } from '../commands/policy/text-inputs.ts';

type PolicyCommonOptions = AgentDeviceRequestOverrides & AgentDeviceSelectionOptions;

export type PolicySuggestClientOptions = PolicyCommonOptions & {
  goal: string;
  policy?: string;
};

export type PolicyActClientOptions = PolicySuggestClientOptions & {
  maxSteps?: number;
  minConfidence?: number;
  /** Repeated `key=value` tokens naming text the loop may enter. */
  inputs?: readonly string[];
  onStep?: (step: PolicyActStep) => void;
};

/**
 * The client calls the loop needs, narrowed to three. Narrowing here rather than passing the whole
 * client keeps the loop's device surface visible at the seam where it is granted.
 */
export type PolicyClientCalls = {
  snapshot: (options: PolicyCommonOptions & { interactiveOnly: true }) => Promise<{
    nodes: PolicySnapshotNode[];
    refsGeneration?: number;
  }>;
  press: (options: PolicyCommonOptions & { ref: string; settle?: boolean }) => Promise<unknown>;
  fill: (
    options: PolicyCommonOptions & { ref: string; text: string; settle?: boolean },
  ) => Promise<unknown>;
};

export async function suggestPolicyAction(
  calls: PolicyClientCalls,
  options: PolicySuggestClientOptions,
  env: Readonly<Record<string, string | undefined>>,
): Promise<PolicySuggestResult> {
  const provider = createPolicyProvider(options.policy ?? DEFAULT_POLICY_PROVIDER, env);
  const common = commonOf(options);
  const startedAt = Date.now();
  const snapshot = await calls.snapshot({ ...common, interactiveOnly: true });
  const snapshotMs = Date.now() - startedAt;

  const candidates = toPolicyCandidates(snapshot.nodes);
  const screen = screenLabel(candidates);
  const decision = await provider.decide({
    goal: options.goal,
    candidates,
    history: [],
    screen,
    // `suggest` reports what the screen affords; it enters no text, so it claims none is ready.
    textReadyRefs: [],
  });
  return { goal: options.goal, decision, candidates, snapshotMs, screen };
}

export async function runPolicyAct(
  calls: PolicyClientCalls,
  options: PolicyActClientOptions,
  env: Readonly<Record<string, string | undefined>>,
): Promise<PolicyActResult> {
  const provider = createPolicyProvider(options.policy ?? DEFAULT_POLICY_PROVIDER, env);
  return await runPolicyActLoop({
    goal: options.goal,
    provider,
    device: createPolicyDevicePort(calls, commonOf(options)),
    inputs: parsePolicyTextInputs(options.inputs ?? []),
    env,
    maxSteps: options.maxSteps ?? DEFAULT_POLICY_MAX_STEPS,
    minConfidence: options.minConfidence ?? DEFAULT_POLICY_MIN_CONFIDENCE,
    ...(options.onStep ? { onStep: options.onStep } : {}),
  });
}

/**
 * Bind the loop to a live session.
 *
 * Every mutation is pinned to the generation of the snapshot that issued its ref (ADR 0014), so a
 * decision made against a screen that has since changed is refused by the daemon rather than
 * landing on whatever element inherited the ref.
 */
function createPolicyDevicePort(
  calls: PolicyClientCalls,
  common: PolicyCommonOptions,
): PolicyDevicePort {
  let generation: number | undefined;
  const pinned = (ref: string): string => {
    const body = ref.startsWith('@') ? ref.slice(1) : ref;
    return generation === undefined ? `@${body}` : `@${body}~s${generation}`;
  };
  const timed = async (run: () => Promise<unknown>): Promise<number> => {
    const startedAt = Date.now();
    await run();
    return Date.now() - startedAt;
  };

  return {
    snapshot: async () => {
      const startedAt = Date.now();
      const result = await calls.snapshot({ ...common, interactiveOnly: true });
      generation = result.refsGeneration;
      return { nodes: result.nodes, ms: Date.now() - startedAt };
    },
    press: async (ref) =>
      await timed(async () => await calls.press({ ...common, ref: pinned(ref), settle: true })),
    fill: async (ref, text) =>
      await timed(
        async () => await calls.fill({ ...common, ref: pinned(ref), text, settle: true }),
      ),
  };
}

function commonOf(options: PolicySuggestClientOptions): PolicyCommonOptions {
  const { goal: _goal, policy: _policy, ...common } = options as PolicyActClientOptions;
  const {
    maxSteps: _maxSteps,
    minConfidence: _minConfidence,
    inputs: _inputs,
    onStep: _onStep,
    ...rest
  } = common as PolicyActClientOptions;
  return rest as PolicyCommonOptions;
}
