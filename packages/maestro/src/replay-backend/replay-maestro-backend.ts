import type {
  ReplayBackend,
  ReplayBackendHost,
  ReplayBackendPlugin,
} from '@agent-device/contracts/replay-backend';
import { projectSelectorExpression } from '@agent-device/selectors';
import {
  collectMaestroFlowSources,
  exportReplayActionsToMaestro,
  inspectMaestroFlow,
  MAESTRO_SELECTOR_PROJECTION,
} from '@agent-device/maestro';
import { runTypedMaestroReplay } from './session-replay-maestro-runtime.ts';

/**
 * The Maestro replay backend plugin (#3377): the engine behind `replay --maestro` and
 * `test --maestro`, handed to the daemon as `create(host)`. Every run goes through the command's
 * `invoke` onto ordinary public commands (ADR 0015), so the engine's own request folding stays in
 * `session-replay-maestro-request.ts` against the daemon's dispatch contract.
 */
function createMaestroReplayBackend(host: ReplayBackendHost): ReplayBackend<'maestro'> {
  return {
    id: 'maestro',
    collectSourceFiles(params) {
      return collectMaestroFlowSources(params);
    },
    inspectSource(source, sourcePath) {
      const flow = inspectMaestroFlow(source, sourcePath);
      return { title: flow.name, appTarget: flow.appTarget };
    },
    async runReplay(command) {
      return await runTypedMaestroReplay(host, command);
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
}

export const maestroReplayBackendPlugin: ReplayBackendPlugin<'maestro'> = {
  create: createMaestroReplayBackend,
};
