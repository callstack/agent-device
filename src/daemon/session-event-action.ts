import { PUBLIC_COMMANDS } from '../command-catalog.ts';
import type { SessionAction } from './types.ts';
import { definedEventDetails } from './session-event-details.ts';

export function buildActionSummary(action: SessionAction): string {
  const message = readString(action.result?.message);
  if (message) return message;
  switch (action.command) {
    case PUBLIC_COMMANDS.open:
      return `Opened ${readActionTargetLabel(action) ?? 'session'}`;
    case PUBLIC_COMMANDS.close:
      return `Closed ${readString(action.result?.session) ?? 'session'}`;
    case PUBLIC_COMMANDS.click:
    case PUBLIC_COMMANDS.press:
      return `Tapped ${readActionTargetLabel(action) ?? 'target'}`;
    case PUBLIC_COMMANDS.longPress:
      return `Long pressed ${readActionTargetLabel(action) ?? 'target'}`;
    case PUBLIC_COMMANDS.fill:
      return `Filled ${readActionTargetLabel(action) ?? 'target'}`;
    case PUBLIC_COMMANDS.install:
    case PUBLIC_COMMANDS.reinstall:
    case 'install_source':
      return `Installed ${readActionTargetLabel(action) ?? 'app'}`;
    default:
      return `Ran ${action.command}`;
  }
}

export function buildActionDetails(action: SessionAction): Record<string, unknown> {
  const result = action.result ?? {};
  return definedEventDetails({
    command: action.command,
    positionals: buildDisplayPositionals(action),
    flags: action.flags,
    action: result.action,
    message: result.message,
    ref: result.ref,
    refLabel: result.refLabel,
    selector: result.selector,
    selectorChain: readStringArray(result.selectorChain),
    x: result.x,
    y: result.y,
    x2: result.x2,
    y2: result.y2,
    durationMs: result.durationMs,
    waitedMs: result.waitedMs,
    found: result.found,
    path: result.path,
    outPath: result.outPath,
    telemetryPath: result.telemetryPath,
    sessionStateDir: result.sessionStateDir,
    requestLogPath: result.requestLogPath,
    runnerLogPath: result.runnerLogPath,
    platform: result.platform,
    target: result.target,
    device: result.device,
    appName: result.appName,
    appBundleId: result.appBundleId,
    bundleId: result.bundleId,
    packageName: result.packageName,
    launchTarget: result.launchTarget,
    textLength: typeof result.text === 'string' ? Array.from(result.text).length : undefined,
    nodeCount: Array.isArray(result.nodes) ? result.nodes.length : undefined,
  });
}

function readActionTargetLabel(action: SessionAction): string | undefined {
  const result = action.result ?? {};
  const ref = readString(result.ref);
  if (ref) return ref.startsWith('@') ? ref : `@${ref}`;
  const selector = readString(result.selector);
  if (selector) return selector;
  const refLabel = readString(result.refLabel);
  if (refLabel) return refLabel;
  const x = readNumber(result.x);
  const y = readNumber(result.y);
  if (x !== undefined && y !== undefined) return `(${x}, ${y})`;
  return (
    readString(result.appName) ??
    readString(result.appBundleId) ??
    readString(result.bundleId) ??
    readString(result.packageName) ??
    action.positionals[0]
  );
}

function buildDisplayPositionals(action: SessionAction): string[] | undefined {
  if (action.command === PUBLIC_COMMANDS.type) {
    return [`<text:${readActionTextLength(action)} chars>`];
  }
  if (action.command === PUBLIC_COMMANDS.fill) {
    return buildFillDisplayPositionals(action);
  }
  if (action.command === PUBLIC_COMMANDS.find) {
    return buildFindDisplayPositionals(action);
  }
  return action.positionals.length > 0 ? action.positionals : undefined;
}

function buildFillDisplayPositionals(action: SessionAction): string[] {
  const textPlaceholder = `<text:${readActionTextLength(action)} chars>`;
  const result = action.result ?? {};
  const ref = readString(result.ref);
  if (ref) return [ref.startsWith('@') ? ref : `@${ref}`, textPlaceholder];
  const selector = readString(result.selector);
  if (selector) return [selector, textPlaceholder];
  const x = readNumber(result.x);
  const y = readNumber(result.y);
  if (x !== undefined && y !== undefined) return [String(x), String(y), textPlaceholder];
  return [textPlaceholder];
}

function buildFindDisplayPositionals(action: SessionAction): string[] | undefined {
  const sensitiveActionIndex = action.positionals.findIndex(
    (value) => value === 'fill' || value === 'type',
  );
  if (sensitiveActionIndex < 0) {
    return action.positionals.length > 0 ? action.positionals : undefined;
  }
  return [
    ...action.positionals.slice(0, sensitiveActionIndex + 1),
    `<text:${readActionTextLength(action)} chars>`,
  ];
}

function readActionTextLength(action: SessionAction): number {
  const resultText = action.result?.text;
  if (typeof resultText === 'string') return Array.from(resultText).length;
  if (action.command === PUBLIC_COMMANDS.type) {
    return Array.from(action.positionals.join(' ')).length;
  }
  return 0;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}
