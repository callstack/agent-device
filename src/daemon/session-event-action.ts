import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '../command-catalog.ts';
import type { SessionAction } from './types.ts';

type ActionTextReplacement = { raw: string; display: string };

export function buildActionSummary(action: SessionAction): string {
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
    case PUBLIC_COMMANDS.type:
      return `Typed ${hiddenValueFromLength('text', readActionTextLength(action))}`;
    case PUBLIC_COMMANDS.install:
    case PUBLIC_COMMANDS.reinstall:
    case INTERNAL_COMMANDS.installSource:
      return `Installed ${readActionTargetLabel(action) ?? 'app'}`;
    default:
      return readSafeActionMessage(action) ?? `Ran ${action.command}`;
  }
}

export function buildActionDetails(action: SessionAction): Record<string, unknown> {
  const result = action.result ?? {};
  return {
    command: action.command,
    positionals: buildDisplayPositionals(action),
    flags: action.flags,
    action: result.action,
    message: readSafeActionMessage(action),
    ref: result.ref,
    targetLabel: readActionTargetLabel(action),
    selectorChainLength: readStringArray(result.selectorChain)?.length,
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
  };
}

function readSafeActionMessage(action: SessionAction): string | undefined {
  const message = readString(action.result?.message);
  if (!message) return undefined;
  if (hasRedactedActionInput(action) || hasValueBearingTargetDetails(action.result ?? {})) {
    return undefined;
  }
  return message;
}

function hasRedactedActionInput(action: SessionAction): boolean {
  return buildActionTextReplacements(action).length > 0;
}

function hasValueBearingTargetDetails(result: Record<string, unknown>): boolean {
  return (
    readString(result.refLabel) !== undefined ||
    readString(result.selector) !== undefined ||
    readStringArray(result.selectorChain) !== undefined
  );
}

function buildActionTextReplacements(action: SessionAction): ActionTextReplacement[] {
  return uniqueActionTextReplacements(
    buildActionTextReplacementCandidates(action).sort(
      (left, right) => right.raw.length - left.raw.length,
    ),
  );
}

function buildActionTextReplacementCandidates(action: SessionAction): ActionTextReplacement[] {
  const displayPositionals = buildDisplayPositionals(action) ?? [];
  const replacements = action.positionals.flatMap((positional, index) => {
    const replacement = buildPositionalTextReplacement(positional, displayPositionals[index]);
    return replacement ? [replacement] : [];
  });
  const resultText = action.result?.text;
  return typeof resultText === 'string' && resultText.length > 0
    ? [{ raw: resultText, display: hiddenValue('text', resultText) }, ...replacements]
    : replacements;
}

function buildPositionalTextReplacement(
  raw: string,
  display: string | undefined,
): ActionTextReplacement | undefined {
  if (!raw) return undefined;
  const replacement = display ?? redactDisplayPositional(raw);
  return replacement === raw ? undefined : { raw, display: replacement };
}

function uniqueActionTextReplacements(
  candidates: ActionTextReplacement[],
): ActionTextReplacement[] {
  const seen = new Set<string>();
  const replacements: ActionTextReplacement[] = [];
  for (const { raw, display } of candidates) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    replacements.push({ raw, display });
  }
  return replacements;
}

function readActionTargetLabel(action: SessionAction): string | undefined {
  const result = action.result ?? {};
  return (
    readElementTargetLabel(result) ??
    readPointTargetLabel(result) ??
    readAppTargetLabel(result) ??
    readSafeDisplayPositional(action.positionals[0])
  );
}

function readElementTargetLabel(result: Record<string, unknown>): string | undefined {
  const ref = readString(result.ref);
  if (ref) return ref.startsWith('@') ? ref : `@${ref}`;
  return undefined;
}

function readPointTargetLabel(result: Record<string, unknown>): string | undefined {
  const x = readNumber(result.x);
  const y = readNumber(result.y);
  if (x !== undefined && y !== undefined) return `(${x}, ${y})`;
  return undefined;
}

function readAppTargetLabel(result: Record<string, unknown>): string | undefined {
  return (
    readString(result.appName) ??
    readString(result.appBundleId) ??
    readString(result.bundleId) ??
    readString(result.packageName)
  );
}

function buildDisplayPositionals(action: SessionAction): string[] | undefined {
  if (action.positionals.length === 0) return undefined;
  if (action.command === PUBLIC_COMMANDS.type) {
    return [hiddenValueFromLength('text', readActionTextLength(action))];
  }
  if (action.command === PUBLIC_COMMANDS.fill) {
    return buildFillDisplayPositionals(action);
  }
  if (action.command === PUBLIC_COMMANDS.find) {
    return buildFindDisplayPositionals(action);
  }
  if (action.command === PUBLIC_COMMANDS.clipboard) {
    return buildClipboardDisplayPositionals(action);
  }
  if (action.command === PUBLIC_COMMANDS.push) {
    return buildPayloadDisplayPositionals(action, 'payload');
  }
  if (action.command === PUBLIC_COMMANDS.triggerAppEvent) {
    return buildPayloadDisplayPositionals(action, 'payload');
  }
  return action.positionals.map(redactDisplayPositional);
}

function buildFillDisplayPositionals(action: SessionAction): string[] {
  const textPlaceholder = hiddenValueFromLength('text', readActionTextLength(action));
  const result = action.result ?? {};
  const ref = readString(result.ref);
  if (ref) return [ref.startsWith('@') ? ref : `@${ref}`, textPlaceholder];
  const selector = readString(result.selector);
  if (selector) return [hiddenValue('target', selector), textPlaceholder];
  const x = readNumber(result.x);
  const y = readNumber(result.y);
  if (x !== undefined && y !== undefined) return [String(x), String(y), textPlaceholder];
  return [textPlaceholder];
}

function buildFindDisplayPositionals(action: SessionAction): string[] | undefined {
  const queryIndex = isFindLocator(action.positionals[0]) ? 1 : 0;
  const query = action.positionals[queryIndex];
  if (query === undefined) return undefined;
  const actionIndex = queryIndex + 1;
  const prefix = [
    ...(queryIndex === 1 ? [String(action.positionals[0])] : []),
    hiddenValue('query', query),
  ];
  const findAction = action.positionals[actionIndex];
  if (!findAction) return prefix;
  if (findAction === 'fill' || findAction === 'type') {
    return [...prefix, findAction, hiddenValueFromLength('text', readActionTextLength(action))];
  }
  return [...prefix, ...action.positionals.slice(actionIndex).map(redactFindActionPositional)];
}

function buildClipboardDisplayPositionals(action: SessionAction): string[] {
  const clipboardAction = action.positionals[0]?.toLowerCase();
  if (clipboardAction === 'read') return ['read'];
  if (clipboardAction === 'write') {
    return ['write', hiddenValueFromLength('text', readClipboardWriteLength(action))];
  }
  return action.positionals.map(redactDisplayPositional);
}

function buildPayloadDisplayPositionals(action: SessionAction, payloadLabel: string): string[] {
  const [target, payload, ...extra] = action.positionals;
  return [
    ...(target ? [target] : []),
    ...(payload ? [hiddenValue(payloadLabel, payload)] : []),
    ...extra.map(redactDisplayPositional),
  ];
}

function redactFindActionPositional(value: string): string {
  if (
    value === 'click' ||
    value === 'focus' ||
    value === 'exists' ||
    value === 'get' ||
    value === 'text' ||
    value === 'attrs' ||
    value === 'wait'
  ) {
    return value;
  }
  return redactDisplayPositional(value);
}

function readActionTextLength(action: SessionAction): number {
  const resultText = action.result?.text;
  if (typeof resultText === 'string') return Array.from(resultText).length;
  if (action.command === PUBLIC_COMMANDS.type) {
    return Array.from(action.positionals.join(' ')).length;
  }
  return 0;
}

function readClipboardWriteLength(action: SessionAction): number {
  const textLength = action.result?.textLength;
  if (typeof textLength === 'number' && Number.isFinite(textLength)) return textLength;
  return Array.from(action.positionals.slice(1).join(' ')).length;
}

function redactDisplayPositional(value: string): string {
  return readSafeDisplayPositional(value) ?? hiddenValue('arg', value);
}

function readSafeDisplayPositional(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^@[a-zA-Z0-9:_-]+$/.test(trimmed)) return trimmed;
  return undefined;
}

function hiddenValue(label: string, value: string): string {
  return hiddenValueFromLength(label, Array.from(value).length);
}

function hiddenValueFromLength(label: string, length: number): string {
  return `<${label}:${length} chars>`;
}

function isFindLocator(value: string | undefined): boolean {
  return (
    value === 'text' || value === 'label' || value === 'value' || value === 'role' || value === 'id'
  );
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim().length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}
