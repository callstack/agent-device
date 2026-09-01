import { isIosFamily } from '@agent-device/kernel/device';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { isActiveProviderDevice } from '../provider-device-runtime.ts';
import { isPostGestureStabilizationPending } from './deferred-interaction-outcome.ts';
import type { SessionState } from './types.ts';
import { readSimpleSelectorTarget } from '@agent-device/selectors';
import { asAppError } from '@agent-device/kernel/errors';
import type { ElementSelectorTapOptions } from '@agent-device/contracts/interactor-types';
import { queryAppleRuntimeSelector } from '../platform-runtime-apple-resources.ts';
import type { AppleRunnerRequestOptions } from './apple-runner-options.ts';

export type DirectIosSelectorTarget = ElementSelectorTapOptions & { raw: string };

export function isLocalIosRunnerSession(
  session: SessionState | undefined,
  options: { skipPendingPostGestureStabilization: boolean },
): session is SessionState {
  if (!session) return false;
  if (!isIosFamily(session.device)) return false;
  if (isActiveProviderDevice(session.device)) return false;
  if (options.skipPendingPostGestureStabilization && isPostGestureStabilizationPending(session)) {
    return false;
  }
  return true;
}

export function readSimpleIosSelectorTarget(params: {
  session: SessionState | undefined;
  selectorExpression: string;
}): DirectIosSelectorTarget | null {
  const { session, selectorExpression } = params;
  if (!isLocalIosRunnerSession(session, { skipPendingPostGestureStabilization: true })) {
    return null;
  }
  return readSimpleSelectorTarget(selectorExpression);
}

export function deriveDirectIosNodeSelector(
  node: Pick<SnapshotNode, 'identifier' | 'label'>,
): { key: 'id' | 'label'; value: string } | null {
  const identifier = node.identifier?.trim();
  if (identifier) return { key: 'id', value: identifier };
  const label = node.label?.trim();
  if (label) return { key: 'label', value: label };
  return null;
}

export type DirectIosSelectorQueryResult = {
  found: boolean;
  text?: string;
  node?: SnapshotNode;
};

export async function queryDirectIosSelector(
  session: SessionState,
  selector: Pick<DirectIosSelectorTarget, 'key' | 'value'>,
  requestOptions: AppleRunnerRequestOptions,
): Promise<DirectIosSelectorQueryResult> {
  const data = await queryAppleRuntimeSelector(
    session.device,
    selector,
    session.appBundleId,
    requestOptions,
  );
  const found = data.found === true;
  const node = readDirectIosSelectorNode(data);
  return {
    found,
    ...(typeof data.text === 'string' ? { text: data.text } : {}),
    ...(node ? { node } : {}),
  };
}

function readDirectIosSelectorNode(data: Record<string, unknown>): SnapshotNode | undefined {
  const nodes = data.nodes;
  if (!Array.isArray(nodes)) return undefined;
  const node = nodes[0];
  if (!node || typeof node !== 'object') return undefined;
  return node as SnapshotNode;
}

export function isDirectIosSelectorFallbackError(
  error: unknown,
  options: {
    allowElementNotFound?: boolean;
    delegateSemanticFailures?: boolean;
  } = {},
): boolean {
  const appError = asAppError(error);
  if (appError.code === 'ELEMENT_NOT_FOUND') {
    return options.delegateSemanticFailures === true || options.allowElementNotFound === true;
  }
  if (appError.code === 'AMBIGUOUS_MATCH') return options.delegateSemanticFailures === true;
  if (appError.code === 'ELEMENT_OFFSCREEN') {
    return options.delegateSemanticFailures !== false;
  }
  if (appError.code !== 'COMMAND_FAILED') return false;
  const message = appError.message.toLowerCase();
  return (
    message.includes('fetch failed') ||
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('runner did not accept connection') ||
    message.includes('invalid runner response')
  );
}
