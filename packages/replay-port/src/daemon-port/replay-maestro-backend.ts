import {
  collectMaestroFlowSources,
  exportReplayActionsToMaestro,
  inspectMaestroFlow,
  MAESTRO_SELECTOR_PROJECTION,
} from '@agent-device/maestro';
import { projectSelectorExpression } from '@agent-device/selectors';
import type { ReplayBackend } from './replay-backend-registry.ts';
import { runTypedMaestroReplay } from './session-replay-maestro-runtime.ts';

/**
 * The Maestro backend registration (#3377).
 *
 * This module and the `session-replay-maestro-*` adapters it wires are the Maestro plugin's
 * future home: they are the only production code outside `packages/maestro` that names the engine
 * package, and the registry reaches them through one thunk. The 0.22 extraction relocates this
 * cluster into the plugin and registers it there — the registry, the daemon's replay command, and
 * the client-side replay surface keep their shape.
 *
 * What the backend may not do is own dispatch: every run goes through the command's `invoke` onto
 * ordinary public commands (ADR 0015), so the engine's own request folding stays in
 * `session-replay-maestro-request.ts` against the daemon's `ReplayDispatchOptions` contract.
 */
export const maestroBackend: ReplayBackend = {
  id: 'maestro',
  collectSourceFiles(params) {
    return collectMaestroFlowSources(params);
  },
  inspectSource(source, sourcePath) {
    const flow = inspectMaestroFlow(source, sourcePath);
    return { title: flow.name, appTarget: flow.appTarget };
  },
  async runReplay(command) {
    return await runTypedMaestroReplay(command);
  },
  exportReplayScript(actions, options) {
    // The selector vocabulary a Maestro flow understands is this backend's knowledge, so the
    // projection lives here rather than at the CLI call site, which would keep a second copy of
    // the key lists that nothing keeps in step.
    return exportReplayActionsToMaestro(actions, {
      ...options,
      resolveSelector: (expression) =>
        projectSelectorExpression(expression, MAESTRO_SELECTOR_PROJECTION),
    });
  },
};
