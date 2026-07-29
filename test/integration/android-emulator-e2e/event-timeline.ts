export type EventTimelinePage = {
  events?: unknown;
  nextCursor?: unknown;
};

type EventTimeline = {
  commands: string[];
  pages: Array<{ cursor: string; eventCount: number; nextCursor?: string }>;
};

const MAX_EVENT_TIMELINE_PAGES = 100;

export async function collectPagedEventTimeline(
  readPage: (cursor?: string) => Promise<EventTimelinePage>,
): Promise<EventTimeline> {
  const commands: string[] = [];
  const pages: EventTimeline['pages'] = [];
  let cursor: string | undefined;
  let offset = 0;
  while (pages.length < MAX_EVENT_TIMELINE_PAGES) {
    const page = await readPage(cursor);
    if (!Array.isArray(page.events)) throw new Error('events page must contain an events array');
    const pageCommands = page.events.map((event, index) => readCommand(event, index, cursor));
    commands.push(...pageCommands);
    const next = readNextCursor(page.nextCursor, offset);
    pages.push({
      cursor: cursor ?? '0',
      eventCount: pageCommands.length,
      ...(next === undefined ? {} : { nextCursor: next.cursor }),
    });
    if (next === undefined) return { commands, pages };
    cursor = next.cursor;
    offset = next.offset;
  }
  throw new Error(`events pagination exceeded ${MAX_EVENT_TIMELINE_PAGES} pages`);
}

function readCommand(event: unknown, index: number, cursor: string | undefined): string {
  if (
    typeof event !== 'object' ||
    event === null ||
    Array.isArray(event) ||
    typeof (event as { command?: unknown }).command !== 'string'
  ) {
    throw new Error(`events entry ${index} at cursor ${cursor ?? '0'} must name a command`);
  }
  return (event as { command: string }).command;
}

function readNextCursor(
  value: unknown,
  currentOffset: number,
): { cursor: string; offset: number } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error('events nextCursor must be a canonical non-negative integer string');
  }
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset <= currentOffset) {
    throw new Error(`events pagination did not advance beyond cursor ${currentOffset}`);
  }
  return { cursor: value, offset };
}
