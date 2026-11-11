const MAX_LINES = 5000;
const MAX_LINE_CHARS = 4000;

type ObjectPreview = {
  subtype?: string;
  overflow: boolean;
  properties: { name: string; value?: string; type: string }[];
  entries?: unknown[];
};
type RemoteObject = {
  type?: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
  preview?: ObjectPreview;
};

export type PageLog = Readonly<{
  /** Feed of CDP events from the attached page. */
  record(method: string, params: Record<string, unknown>): void;
  tail(lineCount: number): string;
}>;

function describe(argument: RemoteObject): string {
  if (argument.type === 'string') return String(argument.value);
  if (argument.unserializableValue) return argument.unserializableValue;
  if (argument.value !== undefined) return JSON.stringify(argument.value);
  // Map and Set previews carry their contents in entries, which the description summarises.
  if (argument.preview && !argument.preview.entries) return describePreview(argument.preview);
  return argument.description ?? argument.type ?? '';
}

function describePreview({ subtype, overflow, properties }: ObjectPreview): string {
  const isArray = subtype === 'array';
  const entries = properties.map(({ name, value, type }) => {
    const shown = type === 'string' ? JSON.stringify(value) : (value ?? type);
    return isArray ? shown : `${name}: ${shown}`;
  });
  if (overflow) entries.push('…');
  return isArray ? `[${entries.join(', ')}]` : `{${entries.join(', ')}}`;
}

export function createPageLog(now = () => new Date()): PageLog {
  const lines: string[] = [];

  const push = (text: string) => {
    lines.push(
      `${now().toISOString()} ${text}`.replaceAll(/\s*\n\s*/g, ' ').slice(0, MAX_LINE_CHARS),
    );
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  };

  const handlers: Readonly<Record<string, (params: Record<string, unknown>) => void>> = {
    'Runtime.consoleAPICalled': (params) => {
      const args = Array.isArray(params.args)
        ? params.args.filter(
            (argument): argument is RemoteObject =>
              typeof argument === 'object' && argument !== null,
          )
        : [];
      push(`console.${String(params.type)} ${args.map(describe).join(' ')}`);
    },
    'Runtime.exceptionThrown': (params) => {
      const details = params.exceptionDetails as
        | { text?: string; exception?: RemoteObject }
        | undefined;
      push(`exception ${details?.exception?.description ?? details?.text ?? 'unknown'}`);
    },
    'Log.entryAdded': (params) => {
      const entry = params.entry as { level?: string; text?: string; url?: string } | undefined;
      if (!entry) return;
      push(`log.${String(entry.level)} ${String(entry.text)}${entry.url ? ` ${entry.url}` : ''}`);
    },
  };

  return {
    record: (method, params) => handlers[method]?.(params),
    tail: (lineCount) =>
      lines
        .slice(-lineCount)
        .map((line) => `${line}\n`)
        .join(''),
  };
}
