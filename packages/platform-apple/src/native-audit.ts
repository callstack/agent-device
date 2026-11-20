import type {
  NativeAuditFinding,
  IosNativeAuditType,
  AccessibilityAuditInput,
} from '@agent-device/contracts/capture';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { runAppleRunnerCommand } from './core/runner-client.ts';

export async function collectNativeAudit(
  device: DeviceInfo,
  input: AccessibilityAuditInput,
  signal: AbortSignal,
): Promise<NativeAuditFinding[]> {
  const data = await runAppleRunnerCommand(
    device,
    {
      command: 'accessibilityAudit',
      appBundleId: input.appBundleId,
    },
    { ...input, signal: input.signal ? AbortSignal.any([signal, input.signal]) : signal },
  );
  return mapNativeAuditIssues(data);
}

function mapNativeAuditIssues(data: Record<string, unknown>): NativeAuditFinding[] {
  if (!Array.isArray(data.auditIssues)) {
    throw new AppError('COMMAND_FAILED', 'Runner returned no native audit result.', {
      reason: 'native-audit-invalid-result',
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
        reason: 'native-audit-invalid-result',
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
    reason: 'native-audit-invalid-result',
  });
}

function isUnknownAuditType(value: string): value is `unknown:${string}` {
  return value.startsWith('unknown:');
}
