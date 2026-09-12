import { test, expect } from 'vitest';
import { LeaseInFlightWorkRegistry } from '../lease-in-flight-work.ts';

test('a pass defers its lease until it is released', () => {
  const work = new LeaseInFlightWorkRegistry();
  const pass = work.retain('lease-a', () => true);

  expect(work.isDeferred('lease-a')).toBe(true);
  expect(pass.release()).toBe(true);
  expect(work.isDeferred('lease-a')).toBe(false);
});

// The deferral is a claim that somebody is still waiting. The client hanging up
// ends the claim immediately, without waiting for the abandoned work to unwind.
test('a pass whose request was cancelled stops deferring unreleased', () => {
  const work = new LeaseInFlightWorkRegistry();
  let wanted = true;
  const pass = work.retain('lease-a', () => wanted);
  wanted = false;

  expect(work.isDeferred('lease-a')).toBe(false);
  expect(pass.release()).toBe(false);
});

// Two requests can work one leased device. Only work still wanted defers, and one
// release must not disturb a pass that outlives it.
test('one wanted pass keeps deferral while an abandoned sibling releases', () => {
  const work = new LeaseInFlightWorkRegistry();
  let abandonedWanted = true;
  const abandoned = work.retain('lease-a', () => abandonedWanted);
  const wanted = work.retain('lease-a', () => true);
  abandonedWanted = false;

  expect(abandoned.release()).toBe(false);
  expect(work.isDeferred('lease-a')).toBe(true);
  expect(wanted.release()).toBe(true);
  expect(work.isDeferred('lease-a')).toBe(false);
});

test('releasing a pass twice renews nothing twice', () => {
  const work = new LeaseInFlightWorkRegistry();
  const pass = work.retain('lease-a', () => true);

  expect(pass.release()).toBe(true);
  expect(pass.release()).toBe(false);
});

test('passes on different leases defer independently', () => {
  const work = new LeaseInFlightWorkRegistry();
  const other = work.retain('lease-b', () => true);

  expect(work.isDeferred('lease-a')).toBe(false);
  expect(work.isDeferred('lease-b')).toBe(true);
  other.release();
});

// Leases churn with every connect and close, and a released lease is never read by
// the expiry sweep again. A key left behind per released lease is a permanent claim
// on memory the daemon can never reclaim.
test('releasing the last pass leaves no claim recorded for its lease', () => {
  const work = new LeaseInFlightWorkRegistry();
  const first = work.retain('lease-a', () => true);
  const second = work.retain('lease-b', () => true);

  first.release();
  second.release();

  expect(claimedLeaseIds(work)).toEqual([]);
});

// Work that outlives its own lease renews nothing, and holds no key either.
test('forgetting a lease releases its claims and disarms the passes running on it', () => {
  const work = new LeaseInFlightWorkRegistry();
  const pass = work.retain('lease-a', () => true);

  work.forget('lease-a');

  expect(claimedLeaseIds(work)).toEqual([]);
  expect(pass.release()).toBe(false);
});

function claimedLeaseIds(work: LeaseInFlightWorkRegistry): string[] {
  const claims = (work as unknown as { entriesByLeaseId: Map<string, unknown> }).entriesByLeaseId;
  return [...claims.keys()];
}
