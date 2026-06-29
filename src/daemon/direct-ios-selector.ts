import type { SessionState } from './types.ts';
import { tryParseSelectorChain } from './selectors.ts';
import { asAppError } from '../kernel/errors.ts';
import type { ElementSelectorTapOptions } from '../core/interactor-types.ts';

export type DirectIosSelectorTarget = ElementSelectorTapOptions & { raw: string };

export function readSimpleIosSelectorTarget(params: {
  session: SessionState | undefined;
  selectorExpression: string;
}): DirectIosSelectorTarget | null {
  const { session, selectorExpression } = params;
  if (!session) return null;
  if (session.device.platform !== 'ios') return null;
  if (session.postGestureStabilization) return null;
  const chain = tryParseSelectorChain(selectorExpression);
  if (!chain) return null;
  if (chain.selectors.length !== 1) return null;
  const selector = chain.selectors[0];
  if (!selector || selector.terms.length !== 1) return null;
  const term = selector.terms[0];
  if (!term || typeof term.value !== 'string') return null;
  if (!isRunnerNativeSelectorKey(term.key)) return null;
  return { key: term.key, value: term.value, raw: selector.raw };
}

function isRunnerNativeSelectorKey(key: string): key is DirectIosSelectorTarget['key'] {
  return key === 'id' || key === 'label' || key === 'text' || key === 'value';
}

export function isDirectIosSelectorFallbackError(
  error: unknown,
  options: { allowElementNotFound?: boolean } = {},
): boolean {
  const appError = asAppError(error);
  if (appError.code === 'ELEMENT_NOT_FOUND') return options.allowElementNotFound === true;
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
