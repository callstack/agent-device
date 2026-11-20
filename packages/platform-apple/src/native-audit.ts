import type {
  NativeAuditFinding,
  IosNativeAuditType,
  AccessibilityAuditInput,
} from '@agent-device/contracts/capture';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { isRunnerNativeAuditUnavailableError } from '@agent-device/apple-runner';
import { runAppleRunnerCommand } from './core/runner-client.ts';

/**
 * Apple's native findings for the session app. A runner on an OS older than iOS 17 has no native
 * audit, so it contributes no findings and `audit` answers with its heuristic findings alone.
 */
export async function collectNativeAudit(
  device: DeviceInfo,
  input: AccessibilityAuditInput,
  signal: AbortSignal,
): Promise<NativeAuditFinding[]> {
  try {
    const data = await runAppleRunnerCommand(
      device,
      {
        command: 'accessibilityAudit',
        appBundleId: input.appBundleId,
      },
      { ...input, signal: input.signal ? AbortSignal.any([signal, input.signal]) : signal },
    );
    return mapNativeAuditIssues(data).sort(compareNativeAuditFindings);
  } catch (error) {
    if (isRunnerNativeAuditUnavailableError(error)) return [];
    throw error;
  }
}

/**
 * Published `details.reason` values for a native audit the runner answered with a malformed result.
 * `website/docs/docs/commands.md` documents each value.
 */
const NATIVE_AUDIT_FAILURES = {
  invalidResult: { reason: 'native-audit-invalid-result' },
} as const satisfies Record<string, { reason: string }>;

function mapNativeAuditIssues(data: Record<string, unknown>): NativeAuditFinding[] {
  if (!Array.isArray(data.auditIssues)) {
    throw new AppError('COMMAND_FAILED', 'Runner returned no native audit result.', {
      reason: NATIVE_AUDIT_FAILURES.invalidResult.reason,
    });
  }
  return data.auditIssues.map((issue: unknown) => {
    if (
      typeof issue !== 'object' ||
      issue === null ||
      !('auditType' in issue) ||
      typeof issue.auditType !== 'string' ||
      !('description' in issue) ||
      typeof issue.description !== 'string'
    ) {
      throw new AppError('COMMAND_FAILED', 'Runner returned an invalid native audit issue.', {
        reason: NATIVE_AUDIT_FAILURES.invalidResult.reason,
      });
    }
    const rect = readNativeAuditRect('rect' in issue ? issue.rect : undefined);
    return {
      source: 'native',
      kind: 'native',
      severity: 'warning',
      platform: 'ios',
      auditType: nativeAuditType(issue.auditType),
      description: issue.description,
      ...(rect ? { rect } : {}),
    };
  });
}

/**
 * Apple delivers issues in an order that changes between runs of one unchanged screen. Order them
 * by check, then top to bottom and left to right, so two audits of that screen print the same list.
 */
function compareNativeAuditFindings(a: NativeAuditFinding, b: NativeAuditFinding): number {
  const [aOrigin, aSize] = frameSortKeys(a);
  const [bOrigin, bSize] = frameSortKeys(b);
  return (
    compareText(a.auditType, b.auditType) ||
    compareNumbers(aOrigin, bOrigin) ||
    compareText(a.description, b.description) ||
    compareNumbers(aSize, bSize)
  );
}

/** Top to bottom, then left to right, then by size. A finding without a frame sorts last. */
function frameSortKeys({ rect }: NativeAuditFinding): [origin: number[], size: number[]] {
  return rect
    ? [
        [rect.y, rect.x],
        [rect.width, rect.height],
      ]
    : [
        [Infinity, Infinity],
        [Infinity, Infinity],
      ];
}

function compareNumbers(a: readonly number[], b: readonly number[]): number {
  for (const [index, value] of a.entries()) {
    const other = b[index] ?? Infinity;
    if (value !== other) return value < other ? -1 : 1;
  }
  return 0;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function nativeAuditType(value: string): IosNativeAuditType {
  switch (value) {
    case 'contrast':
    case 'dynamicType':
    case 'elementDetection':
    case 'hitRegion':
    case 'sufficientElementDescription':
    case 'textClipped':
    case 'trait':
      return value;
    default: {
      return isUnknownAuditType(value) ? value : `unknown:${value}`;
    }
  }
}

function readNativeAuditRect(value: unknown) {
  if (value === undefined) return undefined;
  if (
    typeof value === 'object' &&
    value !== null &&
    'x' in value &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    'y' in value &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y) &&
    'width' in value &&
    typeof value.width === 'number' &&
    Number.isFinite(value.width) &&
    'height' in value &&
    typeof value.height === 'number' &&
    Number.isFinite(value.height)
  ) {
    return { x: value.x, y: value.y, width: value.width, height: value.height };
  }
  throw new AppError('COMMAND_FAILED', 'Runner returned invalid native audit geometry.', {
    reason: NATIVE_AUDIT_FAILURES.invalidResult.reason,
  });
}

function isUnknownAuditType(value: string): value is `unknown:${string}` {
  return value.startsWith('unknown:');
}
