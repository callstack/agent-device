interface CommandEventRecord {
  type?: unknown;
  command?: unknown;
  args?: {
    command?: unknown;
    cmd?: unknown;
  };
}

interface EventReport {
  events?: unknown[];
}

export function extractCommandEvents(report: EventReport): string[] {
  return (report.events ?? []).flatMap(commandFromEvent);
}

export function isAllowedLocalCliHelpCommand(command: string) {
  const segments = localCliHelpSegments(command);
  return segments.length > 0 && segments.every(isAllowedLocalCliHelpSegment);
}

export function isActualLocalCliHelpProbe(command: string) {
  const segments = localCliHelpSegments(command);
  return (
    segments.length > 0 &&
    segments.every(isAllowedLocalCliHelpSegment) &&
    segments.some(isAgentDeviceHelpSegment)
  );
}

function commandFromEvent(event: unknown): string[] {
  if (!isCommandEventRecord(event)) return [];
  const command = directCommandEvent(event) ?? toolCallCommandEvent(event);
  return command === undefined ? [] : [command];
}

function isCommandEventRecord(event: unknown): event is CommandEventRecord {
  return typeof event === 'object' && event !== null;
}

function directCommandEvent(record: CommandEventRecord): string | undefined {
  if (record.type === 'command' && typeof record.command === 'string') {
    return record.command;
  }
  return undefined;
}

function toolCallCommandEvent(record: CommandEventRecord): string | undefined {
  if (record.type !== 'toolCall') return undefined;
  return firstString([record.args?.command, record.args?.cmd]);
}

function firstString(values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string');
}

function localCliHelpSegments(command: string): string[] {
  const strippedCommand = command
    .trim()
    .replace(/^\/bin\/zsh\s+-lc\s+'(.+)'$/, '$1')
    .trim();

  return strippedCommand
    .split(/\s*(?:&&|\|\||[;|])\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function isAllowedLocalCliHelpSegment(command: string) {
  return (
    isAgentDeviceHelpSegment(command) ||
    /^printf\s+["'][^"']*["']$/.test(command) ||
    command === 'cat'
  );
}

function isAgentDeviceHelpSegment(command: string) {
  const helpToken = '[^\\s;&|]+';
  return new RegExp(
    `^(?:node\\s+bin\\/agent-device\\.mjs|agent-device)\\s+(?:(?:help(?:\\s+${helpToken})*)|(?:${helpToken}\\s+)?--help)(?:\\s+2>&1)?$`,
  ).test(command);
}
