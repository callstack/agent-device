import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import type { ClientRequest } from 'node:http';
import { test } from 'vitest';
import { observeCompletedRequestWrites } from '../transport.ts';

class FakeRequest extends EventEmitter {
  destroyed = false;
  accepts = true;
  readonly writes: { self: unknown; args: unknown[] }[] = [];
  write(this: FakeRequest, ...args: unknown[]): boolean {
    this.writes.push({ self: this, args });
    return this.accepts;
  }
  complete(index: number, error: Error | null = null): void {
    const callback = this.writes[index]?.args.find((arg) => typeof arg === 'function');
    assert.ok(typeof callback === 'function', `write ${index} has no callback`);
    callback(error);
  }
}

type Observed = ReturnType<typeof observe>;

function observe(prepare?: (fake: FakeRequest) => void) {
  const fake = new FakeRequest();
  prepare?.(fake);
  const caller = new AbortController();
  const completed = { count: 0 };
  const req = fake as unknown as ClientRequest;
  const dispose = observeCompletedRequestWrites(req, caller.signal, () => (completed.count += 1));
  return { fake, req, caller, completed, dispose };
}

test('only a non-empty write that completes without an error is reported', () => {
  const { fake, req, completed, dispose } = observe();
  req.write(Buffer.from('queued'));
  req.write('', () => {});
  fake.complete(1);
  req.write(new Uint8Array(0), () => {});
  fake.complete(2);
  req.write('failed', () => {});
  fake.complete(3, new Error('EPIPE'));
  for (const [text, encoding] of [
    ['a', 'hex'],
    ['zz', 'hex'],
    ['zz', 'HEX'],
    ['=', 'base64'],
    ['=', 'base64url'],
  ] as const) {
    req.write(text, encoding as BufferEncoding, () => {});
    fake.complete(fake.writes.length - 1);
  }
  assert.equal(
    completed.count,
    0,
    'a queued, empty, failed or encoded-empty write is not progress',
  );
  fake.complete(0);
  assert.equal(completed.count, 1);
  dispose();
});

test.each([
  ['utf8', 'é'],
  ['hex', 'ff'],
  ['base64', 'YQ=='],
  ['base64url', 'YQ'],
] as const)('a successful %s string write is reported', (encoding, text) => {
  const { fake, req, completed, dispose } = observe();
  req.write(text, encoding);
  fake.complete(0);
  assert.equal(completed.count, 1);
  dispose();
});

test('a Uint8Array from another realm is reported', () => {
  const { fake, req, completed, dispose } = observe();
  const chunk = runInNewContext('new Uint8Array([1])') as Uint8Array;
  assert.equal(chunk instanceof Uint8Array, false);
  req.write(chunk);
  fake.complete(0);
  assert.equal(completed.count, 1);
  dispose();
});

test('the observed write keeps every argument, this, the result and one callback', () => {
  const { fake, req, dispose } = observe();
  const calls: unknown[] = [];
  const error = new Error('EPIPE');
  fake.accepts = false;
  assert.equal(
    req.write('a', 'latin1', (cause) => calls.push(cause)),
    false,
  );
  fake.accepts = true;
  assert.equal(
    req.write('b', (cause) => calls.push(cause)),
    true,
  );
  assert.equal(req.write('c'), true);
  assert.deepEqual(
    fake.writes.map(({ self, args }) => [self === fake, ...args.map((arg) => typeof arg)]),
    [
      [true, 'string', 'string', 'function'],
      [true, 'string', 'function'],
      [true, 'string', 'undefined', 'function'],
    ],
  );
  assert.equal(fake.writes[0]?.args[1], 'latin1');
  fake.complete(0, error);
  fake.complete(1);
  fake.complete(2);
  assert.deepEqual(calls, [error, null]);
  dispose();
});

const endings: [string, (observed: Observed) => unknown][] = [
  ['the response started', ({ fake }) => fake.emit('response')],
  ['the signal aborted', ({ caller }) => caller.abort()],
  ['the request was destroyed', ({ fake }) => (fake.destroyed = true)],
  ['the observer was disposed', ({ dispose }) => dispose()],
];

test.each(endings)('a completion after %s is not reported', (_, end) => {
  const observed = observe();
  const calls: unknown[] = [];
  observed.req.write(Buffer.from('late'), (cause) => calls.push(cause));
  end(observed);
  observed.fake.complete(0);
  assert.equal(observed.completed.count, 0);
  assert.deepEqual(calls, [null], 'the caller still hears its own completion');
  observed.dispose();
});

test('disposing removes the listener and restores only the write it wrapped', () => {
  const inherited = observe();
  inherited.dispose();
  assert.equal(inherited.fake.listenerCount('response'), 0);
  assert.equal(Object.hasOwn(inherited.fake, 'write'), false, 'the inherited write is back');
  const ownWrite = () => true;
  const owned = observe((fake) => Object.assign(fake, { write: ownWrite }));
  owned.dispose();
  assert.equal(owned.fake.write, ownWrite, 'an own write is put back');
  const wrapped = observe();
  const foreign = () => true;
  Object.assign(wrapped.fake, { write: foreign });
  wrapped.dispose();
  assert.equal(wrapped.fake.write, foreign, 'a later wrapper stays installed');
});
