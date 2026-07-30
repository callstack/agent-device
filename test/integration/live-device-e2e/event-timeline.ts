export type EventTimelinePage = {
  events?: unknown;
  nextCursor?: unknown;
};

type EventTimeline = {
  commands: string[];
  pages: Array<{
    cursor: string;
    eventCount: number;
    nextCursor?: string;
  }>;
};

const MAX_EVENT_TIMELINE_PAGES = 100;

export async function collectPagedEventTimeline(
  readPage: (cursor?: string) => Promise<EventTimelinePage>,
): Promise<EventTimeline> {
  const commands: string[] = [];
  const pages: EventTimeline['pages'] = [];
  let cursor: string | undefined;
  let cursorOffset = 0;

  while (pages.length < MAX_EVENT_TIMELINE_PAGES) {
    const page = await readPage(cursor);
    const pageCommands = readPageCommands(page.events, cursor);
    const next = readNextCursor(page.nextCursor, cursorOffset);
    commands.push(...pageCommands);
    pages.push({
      cursor: cursor ?? '0',
      eventCount: pageCommands.length,
      ...(next === undefined ? {} : { nextCursor: next.cursor }),
    });
    if (next === undefined) return { commands, pages };

    cursorOffset = next.offset;
    cursor = next.cursor;
  }

  throw new Error(`events pagination exceeded ${MAX_EVENT_TIMELINE_PAGES} pages`);
}

function readPageCommands(events: unknown, cursor: string | undefined): string[] {
  if (!Array.isArray(events)) {
    throw new Error('events page must contain an events array');
  }
  return events.map((event, index) => readEventCommand(event, index, cursor));
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
  if (!Number.isSafeInteger(offset)) {
    throw new Error('events nextCursor must be a safe non-negative integer string');
  }
  if (offset <= currentOffset) {
    throw new Error(`events pagination did not advance beyond cursor ${currentOffset}`);
  }
  return { cursor: value, offset };
}

function readEventCommand(event: unknown, index: number, cursor: string | undefined): string {
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
