import type { ElementTextRuntimeOperations } from '@agent-device/contracts/element-text-runtime';
import { resolveSelectorCaptureRuntimePlan } from '@agent-device/contracts/platform-runtime-operations';
import type {
  FindSelectorRuntimeOperations,
  FindTextRuntimeOperations,
} from '@agent-device/contracts/selector-observation-runtime';
import type {
  CaptureSnapshotInput,
  SnapshotResult,
} from '@agent-device/contracts/snapshot-runtime';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from './request-runtime-binding.ts';
import { admitAndBindSnapshotCapture } from './snapshot-runtime-binding.ts';
import type { DaemonResponse, SessionState } from './types.ts';

/** The selector commands that resolve their targets from the shared request-bound capture seam. */
export type SelectorCaptureCommand = 'find' | 'get' | 'is' | 'wait';

/**
 * One request's bound accessibility capture. Selector commands capture repeatedly under one
 * binding (polling, sparse recovery), so the operation is parametrized by intent rather than
 * frozen at bind time.
 */
export type BoundSelectorCapture = (input: CaptureSnapshotInput) => Promise<SnapshotResult>;

/**
 * The owner's live element-text read, when its facts advertise one. Optional because it is a
 * PREFERRED operation: every selector read's required path answers from the captured tree, so an
 * owner without it still executes the command completely (ADR 0019 §2).
 */
export type BoundSelectorRead = ElementTextRuntimeOperations['readTextAtPoint'];

/** Optional operations appear only for the command intent that declared them. */
export type BoundSelectorFindText = FindTextRuntimeOperations['findText'];
export type BoundSelectorFindSelector = FindSelectorRuntimeOperations['findSelector'];

export type BoundSelectorOperations = Readonly<{
  capture: BoundSelectorCapture;
  readText?: BoundSelectorRead;
  findText?: BoundSelectorFindText;
  findSelector?: BoundSelectorFindSelector;
}>;

export type ResolvedSelectorCapture =
  | Readonly<{ ok: true; operations: BoundSelectorOperations }>
  | Readonly<{ ok: false; response: DaemonResponse }>;

/**
 * The selector family's entry to the shared admit-then-bind path: it contributes the
 * active-app plan and its command name for the refusal wording, and inherits one inspection,
 * refusal-before-bind, and one binding. A sibling unit migrates by naming its command here.
 */
export async function resolveBoundSelectorCapture(
  params: Readonly<{
    command: SelectorCaptureCommand;
    device: SessionState['device'];
    session: SessionState | undefined;
    inspectFacts?: InspectDeviceRuntimeFacts;
    bindDevice?: BindDeviceRuntime;
  }>,
): Promise<ResolvedSelectorCapture> {
  const bound = await admitAndBindSnapshotCapture({
    ...params,
    plan: resolveSelectorCaptureRuntimePlan({
      hasActiveApp: params.session?.appBundleId !== undefined,
      intent: selectorCaptureIntent(params.command),
    }),
    ...(params.session ? {} : { readiness: {} }),
  });
  if (!bound.ok) return bound;
  // The read is present only when the admitted owner advertised it; its absence is not a failure
  // and not a fallback — every selector read's required path answers from the captured tree.
  return {
    ok: true,
    operations: {
      capture: bound.capture,
      ...(bound.readTextAtPoint ? { readText: bound.readTextAtPoint } : {}),
      ...(bound.findText ? { findText: bound.findText } : {}),
      ...(bound.findSelector ? { findSelector: bound.findSelector } : {}),
    },
  };
}

function selectorCaptureIntent(
  command: SelectorCaptureCommand,
): 'capture-only' | 'element-text' | 'wait-observation' {
  switch (command) {
    case 'is':
      return 'capture-only';
    case 'find':
    case 'get':
      return 'element-text';
    case 'wait':
      return 'wait-observation';
  }
}
