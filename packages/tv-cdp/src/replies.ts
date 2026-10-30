export type Settlement<T> = Readonly<{ value: T }> | Readonly<{ error: Error }>;

type Waiter<Reply> = Readonly<{
  receive(reply: Reply): void;
  fail(error: Error): void;
}>;

export type ReplyWaiters<Reply> = Readonly<{
  wait<T>(
    id: string,
    timeoutMs: number,
    timeoutError: () => Error,
    settle: (reply: Reply) => Settlement<T> | undefined,
  ): Promise<T>;
  deliver(id: string, reply: Reply): void;
  failAll(error: Error): void;
}>;

export function createReplyWaiters<Reply>(): ReplyWaiters<Reply> {
  const waiters = new Map<string, Waiter<Reply>>();
  let failure: Error | undefined;
  return {
    wait: (id, timeoutMs, timeoutError, settle) =>
      new Promise((resolve, reject) => {
        if (failure) {
          reject(failure);
          return;
        }
        const finish = () => {
          clearTimeout(timer);
          waiters.delete(id);
        };
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(timeoutError());
        }, timeoutMs);
        waiters.set(id, {
          receive: (reply) => {
            const settlement = settle(reply);
            if (!settlement) return;
            finish();
            if ('error' in settlement) reject(settlement.error);
            else resolve(settlement.value);
          },
          fail: (error) => {
            finish();
            reject(error);
          },
        });
      }),
    deliver: (id, reply) => waiters.get(id)?.receive(reply),
    failAll: (error) => {
      failure = error;
      for (const waiter of waiters.values()) waiter.fail(error);
    },
  };
}
