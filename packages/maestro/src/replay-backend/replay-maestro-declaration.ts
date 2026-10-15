import type { ReplayBackendDeclaration } from '@agent-device/contracts/replay-backend';
import {
  formatMaestroCompatibilityReference,
  MAESTRO_COMPATIBILITY_ADR_URL,
  MAESTRO_COMPATIBILITY_ISSUE_URL,
} from '../internal/support-matrix.ts';

export const maestroReplayBackendDeclaration: ReplayBackendDeclaration<'maestro'> = {
  id: 'maestro',
  help: {
    summary: 'Supported Maestro YAML commands, grammar, and runtime boundaries',
    body: `agent-device help maestro

Run Maestro compatibility flows with replay <flow.yaml> --maestro or test <path> --maestro. Bind an iOS or Android target with --platform or an existing session.

${formatMaestroCompatibilityReference()}

Unsupported syntax fails loudly rather than being skipped. Architecture, performance tradeoffs, and declared conformance divergences: ${MAESTRO_COMPATIBILITY_ADR_URL}
Focused compatibility request: ${MAESTRO_COMPATIBILITY_ISSUE_URL}`,
  },
};
