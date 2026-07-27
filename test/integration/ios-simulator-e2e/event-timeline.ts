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

  while (true) {
    const page = await readPage(cursor);
    if (!Array.isArray(page.events)) {
      throw new Error('events page must contain an events array');
    }
    commands.push(...page.events.map((event, index) => readEventCommand(event, index, cursor)));

    const nextCursor = page.nextCursor;
    if (nextCursor === undefined) {
      pages.push({ cursor: cursor ?? '0', eventCount: page.events.length });
      return { commands, pages };
    }
    if (typeof nextCursor !== 'string' || !/^(?:0|[1-9]\d*)$/.test(nextCursor)) {
      throw new Error('events nextCursor must be a canonical non-negative integer string');
    }
    const nextOffset = Number(nextCursor);
    if (!Number.isSafeInteger(nextOffset)) {
      throw new Error('events nextCursor must be a safe non-negative integer string');
    }
    if (nextOffset <= cursorOffset) {
      throw new Error(`events pagination did not advance beyond cursor ${cursorOffset}`);
    }
    pages.push({
      cursor: cursor ?? '0',
      eventCount: page.events.length,
      nextCursor,
    });
    if (pages.length >= MAX_EVENT_TIMELINE_PAGES) {
      throw new Error(`events pagination exceeded ${MAX_EVENT_TIMELINE_PAGES} pages`);
    }

    cursorOffset = nextOffset;
    cursor = nextCursor;
  }
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
