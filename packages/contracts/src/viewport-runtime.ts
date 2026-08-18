import type { RuntimeOperationFact } from './platform-runtime.ts';

export type SetViewportInput = Readonly<{ width: number; height: number }>;

export type ViewportRuntimeOperations = Readonly<{
  setViewport(input: SetViewportInput): Promise<void>;
}>;

export type ViewportRuntimeOperationFacts = Readonly<{
  setViewport: RuntimeOperationFact;
}>;

export function viewportRuntimeOperationFacts(input: ViewportRuntimeOperationFacts) {
  return Object.freeze({ setViewport: input.setViewport });
}
