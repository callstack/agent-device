import type { AuditSnapshotCommandResult } from './audit.ts';

/** Every plain ref an audit result returns: finding refs, then screen-reader order refs. */
export function auditResultRefs(
  result: Pick<AuditSnapshotCommandResult, 'findings' | 'screenReaderOrder'>,
): string[] {
  return [
    ...result.findings.flatMap((finding) => (finding.ref ? [finding.ref] : [])),
    ...(result.screenReaderOrder?.windows.flatMap((window) => window.refs) ?? []),
  ];
}
