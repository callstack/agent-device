import type { ReasonTable } from '@agent-device/kernel/errors';

/**
 * Why a React DevTools command answers with an error. The in-app runtime answers with these
 * spellings; the injected ES5 source cannot import this table, and its literals are checked
 * against it by `react-devtools-runtime.test.ts`.
 */
export const REACT_DEVTOOLS_REASONS = {
  // The DevTools backend attached to no renderer interface.
  backendAttachFailed: { reason: 'backend-attach-failed' },
  // The DevTools backend could not export the recorded profile.
  collectFailed: { reason: 'collect-failed' },
  // No mounted component has the ref the command named or resolved.
  elementNotFound: { reason: 'element-not-found' },
  // The DevTools backend could not inspect the component.
  inspectFailed: { reason: 'inspect-failed' },
  // The app runtime exposes no DevTools backend for this React Native version.
  noDevtoolsBackend: { reason: 'no-devtools-backend' },
  // The app runtime has no React DevTools hook at all.
  noDevtoolsHook: { reason: 'no-devtools-hook' },
  // React has not rendered in this app runtime yet.
  noReactRenderer: { reason: 'no-react-renderer' },
  // No React profile is recording in this app runtime.
  notProfiling: { reason: 'not-profiling' },
  // The React renderer refused to start profiling.
  startFailed: { reason: 'start-failed' },
  // Another DevTools frontend owns the component tree of this app runtime.
  treeUnavailable: { reason: 'tree-unavailable' },
} as const satisfies ReasonTable<'react-devtools'>;

/** One {@link REACT_DEVTOOLS_REASONS} spelling a failing runtime answer may carry. */
export type ReactDevtoolsFailureReason =
  (typeof REACT_DEVTOOLS_REASONS)[keyof typeof REACT_DEVTOOLS_REASONS]['reason'];
