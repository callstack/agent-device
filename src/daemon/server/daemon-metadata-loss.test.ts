import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { publishDaemonRegistration } from '../../__tests__/test-utils/device-claim-store.ts';
import {
  readDaemonMetadataLoss,
  watchDaemonMetadataLoss,
  type DaemonMetadataLoss,
} from './daemon-metadata-loss.ts';

const OWN_PID = process.pid;
const FOREIGN_PID = 999_999_999;
const OWN = { pid: OWN_PID, startTime: 'own-start' } as const;

function scratch(): { stateDir: string; infoPath: string } {
  const stateDir = mkdtempForTestSync('agent-device-daemon-metadata-loss-');
  return { stateDir, infoPath: path.join(stateDir, 'daemon.json') };
}

function publish(stateDir: string, pid: number, startTime: string | null): void {
  publishDaemonRegistration(stateDir, { pid, startTime });
}

describe('readDaemonMetadataLoss', () => {
  test('a registration naming this daemon is not a loss', () => {
    const { stateDir, infoPath } = scratch();
    publish(stateDir, OWN_PID, 'own-start');

    assert.equal(readDaemonMetadataLoss({ infoPath, stateDir, owner: OWN }), undefined);
  });

  test('a successor that published over this daemon is a loss naming it', () => {
    const { stateDir, infoPath } = scratch();
    publish(stateDir, FOREIGN_PID, 'successor-start');

    assert.deepEqual(readDaemonMetadataLoss({ infoPath, stateDir, owner: OWN }), {
      state: 'replaced',
      registeredPid: FOREIGN_PID,
    });
  });

  test('a record recycling this pid under a different start time is a loss', () => {
    const { stateDir, infoPath } = scratch();
    publish(stateDir, OWN_PID, 'recycled-start');

    assert.deepEqual(readDaemonMetadataLoss({ infoPath, stateDir, owner: OWN }), {
      state: 'replaced',
      registeredPid: OWN_PID,
    });
  });

  test('a registration deleted while the state dir stands is an absent loss', () => {
    const { stateDir, infoPath } = scratch();
    publish(stateDir, OWN_PID, 'own-start');
    fs.rmSync(infoPath);

    assert.deepEqual(readDaemonMetadataLoss({ infoPath, stateDir, owner: OWN }), {
      state: 'absent',
    });
  });

  test('a state dir that was pruned away entirely is not a loss this daemon should report', () => {
    // Reporting one would write a `daemon.log` back into the directory the operator just removed.
    const { stateDir, infoPath } = scratch();
    publish(stateDir, OWN_PID, 'own-start');
    fs.rmSync(stateDir, { recursive: true, force: true });

    assert.equal(readDaemonMetadataLoss({ infoPath, stateDir, owner: OWN }), undefined);
  });

  test.skipIf(process.getuid?.() === 0)(
    'a record this process cannot read is not evidence that it was taken',
    () => {
      // A root-owned CI host reads mode 000 anyway, so the case only binds as a non-root process.
      const { stateDir, infoPath } = scratch();
      publish(stateDir, OWN_PID, 'own-start');
      fs.chmodSync(infoPath, 0o000);
      try {
        assert.equal(readDaemonMetadataLoss({ infoPath, stateDir, owner: OWN }), undefined);
      } finally {
        fs.chmodSync(infoPath, 0o600);
      }
    },
  );

  test('a corrupt record is not evidence that the registration was taken', () => {
    const { stateDir, infoPath } = scratch();
    fs.writeFileSync(infoPath, '{not json');

    assert.equal(readDaemonMetadataLoss({ infoPath, stateDir, owner: OWN }), undefined);
  });
});

describe('watchDaemonMetadataLoss', () => {
  function startWatch(
    stateDir: string,
    infoPath: string,
  ): { losses: DaemonMetadataLoss[]; advance: () => void; cancel: () => void } {
    const losses: DaemonMetadataLoss[] = [];
    const cancel = watchDaemonMetadataLoss({
      infoPath,
      stateDir,
      owner: OWN,
      onLoss: (loss) => losses.push(loss),
    });
    // A window generous against several poll cycles rather than a pin on the interval constant: what
    // these cases own is that a loss is reported once, not how often the poll runs.
    return { losses, advance: () => vi.advanceTimersByTime(60_000), cancel };
  }

  test('reports a takeover once and stops watching', () => {
    vi.useFakeTimers();
    try {
      const { stateDir, infoPath } = scratch();
      publish(stateDir, OWN_PID, 'own-start');
      const watch = startWatch(stateDir, infoPath);
      try {
        watch.advance();
        assert.deepEqual(watch.losses, [], 'owning the record is not a loss');

        publish(stateDir, FOREIGN_PID, 'successor-start');
        watch.advance();
        watch.advance();
        assert.deepEqual(watch.losses, [{ state: 'replaced', registeredPid: FOREIGN_PID }]);
      } finally {
        watch.cancel();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test('a watch cancelled at shutdown stops reporting', () => {
    vi.useFakeTimers();
    try {
      const { stateDir, infoPath } = scratch();
      publish(stateDir, OWN_PID, 'own-start');
      const watch = startWatch(stateDir, infoPath);
      watch.cancel();
      watch.cancel();

      fs.rmSync(infoPath);
      watch.advance();
      assert.deepEqual(watch.losses, []);
    } finally {
      vi.useRealTimers();
    }
  });
});
