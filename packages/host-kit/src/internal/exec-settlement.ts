import type { ExecSettlementReason } from './exec-trace.ts';

export function commandSettlementReason(input: {
  didAbort: boolean;
  exceededStream: 'stdout' | 'stderr' | undefined;
  didTimeout: boolean;
  code: number | null;
  allowFailure: boolean | undefined;
}): ExecSettlementReason {
  if (input.didAbort) return 'abort';
  if (input.exceededStream) return 'output_limit';
  if (input.didTimeout) return 'timeout';
  return (input.code ?? 1) !== 0 && !input.allowFailure ? 'exit_failure' : 'success';
}
