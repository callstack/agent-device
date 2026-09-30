import { commandAcceptsReadinessBudget } from '@agent-device/command-registry/registry';
import { integerField, operatorField } from './command-input.ts';

/**
 * The input field a command's `targetReadiness: 'budgeted'` descriptor trait entitles it to. Only
 * those commands declare `readinessTimeoutMs`; the common input reader refuses the key for every
 * command whose fields do not (`common-input-fields.ts`). Fails closed at module load for a command
 * without the trait, so a field map cannot advertise a budget its runtime never polls under.
 */
export function targetReadinessFields(command: string) {
  if (!commandAcceptsReadinessBudget(command)) {
    throw new Error(`${command} does not declare targetReadiness: 'budgeted'`);
  }
  return {
    readinessTimeoutMs: operatorField(
      integerField(
        "Operator-only: how long the command may poll for a target that does not exist yet, in milliseconds. Capped at the promotedTarget row's maxTimeoutMs; omitted takes the one-attempt resolution path.",
        { min: 1 },
      ),
      {
        operatorPath:
          'Pass readinessTimeoutMs directly as CLI/Node.js command input; it is not exposed to model-facing tools.',
      },
    ),
  };
}
