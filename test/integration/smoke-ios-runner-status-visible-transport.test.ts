import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit/loopback';

type FixtureCommand = {
  command: 'status' | 'tap' | 'type';
  commandId?: string;
  statusCommandId?: string;
  delayMs?: number;
};

type FixtureJournalEntry = {
  command: string;
  state: 'accepted' | 'started' | 'completed' | 'failed';
};

type FixtureResponse = {
  ok: boolean;
  data?: {
    commandId?: string;
    lifecycleState?: string;
    lifecycleCommand?: string;
    message?: string;
  };
};

test('iOS runner status transport stays visible while command execution remains serial', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'iOS runner status-visible transport fixture')) {
    return;
  }

  const fixture = new StatusVisibleRunnerFixture();
  const server = http.createServer((req, res) => {
    void fixture.handle(req, res);
  });
  const port = await listenOnLoopback(server);
  t.after(async () => {
    await closeLoopbackServer(server);
  });

  let longCommandCompleted = false;
  const longCommand = postCommand(port, { command: 'tap', commandId: 'long', delayMs: 300 }).then(
    (response) => {
      longCommandCompleted = true;
      return response;
    },
  );

  const visibleStatus = await pollStatus(port, 'long', (state) => state !== 'notAccepted');
  assert.match(visibleStatus.data?.lifecycleState ?? '', /^(accepted|started)$/);
  assert.equal(longCommandCompleted, false, 'status returned before long command completed');

  const secondCommand = postCommand(port, { command: 'type', commandId: 'second' });
  const secondStatus = await pollStatus(port, 'second', (state) => state === 'accepted');
  assert.equal(secondStatus.data?.lifecycleState, 'accepted');

  assert.deepEqual(await longCommand, { ok: true, data: { message: 'tap completed' } });
  assert.deepEqual(await secondCommand, { ok: true, data: { message: 'type completed' } });
  assert.deepEqual(fixture.events, [
    'long:accepted',
    'long:started',
    'second:accepted',
    'long:completed',
    'second:started',
    'second:completed',
  ]);
});

class StatusVisibleRunnerFixture {
  public readonly events: string[] = [];
  private readonly journal = new Map<string, FixtureJournalEntry>();
  private commandQueue: Promise<void> = Promise.resolve();

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      writeJson(res, 404, { ok: false });
      return;
    }

    const command = await readJsonBody(req);
    if (command.command === 'status') {
      writeJson(res, 200, this.status(command.statusCommandId));
      return;
    }

    this.accept(command);
    const response = this.enqueue(command);
    writeJson(res, 200, await response);
  }

  private accept(command: FixtureCommand): void {
    if (!command.commandId) return;
    this.journal.set(command.commandId, { command: command.command, state: 'accepted' });
    this.events.push(`${command.commandId}:accepted`);
  }

  private enqueue(command: FixtureCommand): Promise<FixtureResponse> {
    const response = this.commandQueue.then(() => this.execute(command));
    this.commandQueue = response.then(
      () => {},
      () => {},
    );
    return response;
  }

  private async execute(command: FixtureCommand): Promise<FixtureResponse> {
    this.update(command, 'started');
    if (command.delayMs) {
      await delay(command.delayMs);
    }
    this.update(command, 'completed');
    return { ok: true, data: { message: `${command.command} completed` } };
  }

  private status(commandId: string | undefined): FixtureResponse {
    if (!commandId) return { ok: true, data: { lifecycleState: 'notAccepted' } };
    const entry = this.journal.get(commandId);
    return {
      ok: true,
      data: {
        commandId,
        lifecycleState: entry?.state ?? 'notAccepted',
        lifecycleCommand: entry?.command,
      },
    };
  }

  private update(command: FixtureCommand, state: FixtureJournalEntry['state']): void {
    if (!command.commandId) return;
    this.journal.set(command.commandId, { command: command.command, state });
    this.events.push(`${command.commandId}:${state}`);
  }
}

async function pollStatus(
  port: number,
  statusCommandId: string,
  predicate: (state: string) => boolean,
): Promise<FixtureResponse> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const response = await postCommand(port, { command: 'status', statusCommandId });
    const state = response.data?.lifecycleState ?? 'notAccepted';
    if (predicate(state)) return response;
    await delay(10);
  }
  throw new Error(`status for ${statusCommandId} did not reach expected state`);
}

async function postCommand(port: number, command: FixtureCommand): Promise<FixtureResponse> {
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
  return (await response.json()) as FixtureResponse;
}

async function readJsonBody(req: http.IncomingMessage): Promise<FixtureCommand> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as FixtureCommand;
}

function writeJson(res: http.ServerResponse, status: number, body: FixtureResponse): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    connection: 'close',
  });
  res.end(JSON.stringify(body));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
