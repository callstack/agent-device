import type { DeviceLease } from '@agent-device/contracts/device';
import type { LimrunPlatform } from './device.ts';
import type { LimrunAndroidSession } from './android.ts';
import type { LimrunIosSession } from './ios.ts';
import type { NetworkCapture, SettledNetworkCapture } from './network-har.ts';

/**
 * One lease's resources in this runtime, and the phase it is in: the create that is making its instance
 * (`allocating`), the instance that create made (`live`), or the one disposal that is ending it
 * (`releasing`). This is the only place a lease's instance, keep-alive timer, network capture and app alias
 * are recorded, so every route that can end one — release, shutdown, expired-lease recovery, and the
 * allocation still waiting on the create — reads it here.
 *
 * The owner is published before its allocation can await anything, so a duplicate allocation joins that
 * create instead of making a second instance, and a release or shutdown arriving while the create runs
 * finds the instance it is on its way to making. `releasing` is entered in the same synchronous step that
 * starts the disposal, and the owner is dropped only once that disposal has confirmed, so a lease is never
 * between owners while one of its instances may be live: an allocation that arrives mid-release is refused,
 * a second release joins the disposal in flight, and shutdown awaits it rather than starting another.
 *
 * Only `LimrunRuntimeImplementation` holds owners, and only its routes write them, so the fields stay
 * mutable and no owner reaches a caller.
 */
export type LimrunLeaseOwner = {
  readonly lease: DeviceLease;
  /** Which platform's instance this lease's create is making, and which one its delete must name. */
  readonly platform: LimrunPlatform;
  /**
   * The create that is making this lease's instance; never rejects unobserved — the runtime reads it. It
   * carries its own outcome, including a refusal to bill anything for this lease's profile flags.
   */
  readonly creation: Promise<LimrunCreateOutcome>;
  state: LimrunLeaseState;
  /**
   * The instance this lease's create rented, recorded the moment Limrun answered, before any session was
   * built on it. A create that could not finish still owes an end for it, and its disposal reads it here.
   */
  rentedInstanceId: string | undefined;
  /** The keep-alive interval for the live instance; started when it went live, cleared by its disposal. */
  keepAlive: NodeJS.Timeout | undefined;
  /** What this lease has in capture terms, including a start whose tunnel is still being opened. */
  capture: LimrunOwnerCapture | undefined;
  /** The uploaded app the instance was created with, and the identifier Limrun installed it under. */
  appAlias: LimrunAppAlias | undefined;
  /** The instance Limrun has already confirmed deleted, so a retried disposal never bills a second delete. */
  deletedInstanceId: string | undefined;
};

/** What one lease has live in this runtime, whatever its platform. */
export type LimrunRuntimeSession = LimrunIosSession | LimrunAndroidSession;

/** Whichever route can end one lease: a release, a daemon close, or the create that failed. */
export type LimrunTeardownRoute = 'release' | 'shutdown' | 'create';

/**
 * What one lease's app alias maps: the uploaded asset's name, and what Limrun installed it under. */
export type LimrunAppAlias = Readonly<{ assetName: string; installedAppId: string }>;

/**
 * What one lease has in capture terms: the start that is still opening its destination tunnel
 * (`starting`), the capture that start came to, or what a settled capture was written as. `starting` is
 * published before the start can answer, so a duplicate allocation joins it instead of opening a second
 * tunnel, and a teardown finds a tunnel that is not there yet and ends it where it lands.
 */
export type LimrunOwnerCapture =
  | Readonly<{ phase: 'starting'; readonly opening: Promise<NetworkCapture> }>
  | NetworkCapture;

/**
 * What ending one lease came to. `cleanup` answers whether this lease's instance is certainly gone:
 * `confirmed` once Limrun deleted it, `attached` when the instance was never this runtime's to delete,
 * `uncertain` when deleting it failed or is still owed, and `none` when the lease never had an instance of
 * its own.
 */
export type LimrunDisposalOutcome = Readonly<{
  cleanup: 'confirmed' | 'attached' | 'uncertain' | 'none';
  /** The instance the lease held, known as soon as the create named it. */
  instanceId: string | undefined;
  /** Why a disposal could not be confirmed; absent once the instance is gone. */
  failure: string | undefined;
  /** The released capture's record, so a refusal can still carry the HAR that was written. */
  capture: SettledNetworkCapture | undefined;
}>;

/**
 * What one create amounted to: the session it made, or why it refused or failed. An instance the create
 * rented before it failed is not carried here — the owner records it as soon as Limrun names it, which is
 * earlier than any outcome could be reported.
 */
export type LimrunCreateOutcome =
  | Readonly<{
      status: 'ready';
      session: LimrunRuntimeSession;
      appAlias: LimrunAppAlias | undefined;
    }>
  | Readonly<{ status: 'failed'; error: unknown }>;

type LimrunLeaseState =
  | Readonly<{ phase: 'allocating' }>
  | Readonly<{ phase: 'live'; session: LimrunRuntimeSession }>
  | LimrunReleasingState;

/**
 * The state of a lease one teardown route owns. Only the take writes it, and only while that route's
 * disposal runs: `settled` is what that disposal reported, and `instanceId` grows to name the instance the
 * create announced while the teardown was already under way.
 */
type LimrunReleasingState = {
  phase: 'releasing';
  /** Which route took the lease from its allocation; one route owns the owner until it confirms. */
  by: LimrunTeardownRoute;
  /** The instance being ended, known as soon as the create named it. */
  instanceId: string | undefined;
  /** The one disposal of this owner, joined by every caller that arrives while it runs. */
  readonly disposal: Promise<LimrunDisposalOutcome>;
  /** What that disposal reported; missing while it runs, so a caller can tell gone from unseen. */
  settled: LimrunDisposalOutcome | undefined;
};
