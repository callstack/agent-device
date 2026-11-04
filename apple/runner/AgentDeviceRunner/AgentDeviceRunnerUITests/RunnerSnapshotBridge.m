#import "RunnerSnapshotBridge.h"

#import <TargetConditionals.h>

#if TARGET_OS_IOS && TARGET_OS_SIMULATOR

// The reader's own translation units, compiled into the runner through HEADER_SEARCH_PATHS so the runner
// and the guest bridge process cannot drift apart. The guest server (SnapshotBridge.m) stays out: the
// runner's transport replaces its socket. The guest build owns the reader's warning flags, so the runner
// target's stricter style checks stop at these includes.
// The runner abandons a read that outlives its budget (RunnerSnapshotBridgeRead) instead of ending the
// process, which also runs every XCTest command.
#define SNAPSHOT_BRIDGE_WATCHDOG_ENDS_PROCESS 0
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wnullability-completeness"
#pragma clang diagnostic ignored "-Wimplicit-retain-self"
#include "SnapshotBridgeCapture.m"
#include "SnapshotBridgeRuntime.m"
#include "SnapshotBridgeSurfaceHosts.m"
#include "SnapshotBridgeRequest.m"
#pragma clang diagnostic pop

#import <objc/runtime.h>
#import <stdatomic.h>
#import <sys/sysctl.h>

@protocol RunnerSnapshotBridgePrimaryApp <NSObject>
+ (id)primaryApp;
- (pid_t)pid;
@end

static NSDictionary *RunnerSnapshotBridgeFailure(NSDictionary *request,
                                                 NSString *kind,
                                                 NSString *code,
                                                 NSString *message)
{
  NSString *requestId = [request[kRequestIdKey] isKindOfClass:NSString.class] ? request[kRequestIdKey] : @"";
  NSMutableDictionary *failure = [failureResponse(requestId, kind, code, message) mutableCopy];
  // A refusal answers the read the host planned, so it names that target; the process the runner
  // found instead travels as `observedPid`, never as the envelope's own pid.
  if ([request[@"expectedPid"] isKindOfClass:NSNumber.class]) failure[@"pid"] = request[@"expectedPid"];
  if ([request[@"generation"] isKindOfClass:NSString.class]) failure[@"generation"] = request[@"generation"];
  return failure;
}

/// The process AXRuntime names as the primary foreground application, the same owner the reader checks
/// before and after a capture.
static pid_t RunnerSnapshotBridgePrimaryPid(void)
{
  Class elementClass = objc_lookUpClass("AXElement");
  if (![elementClass respondsToSelector:@selector(primaryApp)]) return 0;
  id application = [(Class<RunnerSnapshotBridgePrimaryApp>)elementClass primaryApp];
  if (![application respondsToSelector:@selector(pid)]) return 0;
  return [(id<RunnerSnapshotBridgePrimaryApp>)application pid];
}

/// The process start time, as seconds and microseconds since the epoch. With the pid it names one
/// process for its whole life, so a relaunch is a new generation even when the kernel reuses the pid.
static NSString *_Nullable RunnerSnapshotBridgeStartTime(pid_t pid)
{
  struct kinfo_proc info;
  size_t size = sizeof(info);
  int name[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
  if (sysctl(name, 4, &info, &size, NULL, 0) != 0 || size == 0 || info.kp_proc.p_pid != pid) return nil;
  struct timeval started = info.kp_proc.p_starttime;
  return [NSString stringWithFormat:@"%ld.%06d", (long)started.tv_sec, (int)started.tv_usec];
}

/// The executable path of `pid`, the first string `KERN_PROCARGS2` reports after the argument count.
static NSString *_Nullable RunnerSnapshotBridgeExecutable(pid_t pid)
{
  int name[] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t size = 0;
  if (sysctl(name, 3, NULL, &size, NULL, 0) != 0 || size <= sizeof(int)) return nil;
  NSMutableData *buffer = [NSMutableData dataWithLength:size];
  if (sysctl(name, 3, buffer.mutableBytes, &size, NULL, 0) != 0 || size <= sizeof(int)) return nil;
  const char *path = (const char *)buffer.bytes + sizeof(int);
  size_t remaining = size - sizeof(int);
  size_t length = strnlen(path, remaining);
  if (length == 0 || length == remaining) return nil;
  return [[NSString alloc] initWithBytes:path length:length encoding:NSUTF8StringEncoding];
}

/// The bundle identifier of the app bundle that holds the process's executable.
static NSString *_Nullable RunnerSnapshotBridgeBundleId(pid_t pid)
{
  NSString *executable = RunnerSnapshotBridgeExecutable(pid);
  if (!executable) return nil;
  NSRange app = [executable rangeOfString:@".app/" options:NSBackwardsSearch];
  if (app.location == NSNotFound) return nil;
  NSString *bundlePath = [executable substringToIndex:NSMaxRange(app) - 1];
  return [NSBundle bundleWithPath:bundlePath].bundleIdentifier;
}

typedef struct {
  pid_t pid;
  NSString *_Nullable startTime;
} RunnerSnapshotBridgeProcess;

/// The foreground process of `bundleId`, or a failure envelope saying why there is none.
static NSDictionary *_Nullable RunnerSnapshotBridgeResolve(NSString *bundleId,
                                                          NSDictionary *request,
                                                          RunnerSnapshotBridgeProcess *process)
{
  NSString *setupError = nil;
  if (!sharedRuntime(&setupError)) {
    return RunnerSnapshotBridgeFailure(request, @"unsupported", @"runtime-unavailable", setupError);
  }
  pid_t pid = RunnerSnapshotBridgePrimaryPid();
  if (pid <= 0) {
    return RunnerSnapshotBridgeFailure(request, @"application_unavailable", @"foreground-owner-unverified",
                                       @"AXRuntime reported no primary foreground application");
  }
  if (![RunnerSnapshotBridgeBundleId(pid) isEqualToString:bundleId]) {
    return RunnerSnapshotBridgeFailure(request, @"application_unavailable", @"foreground-owner-unverified",
                                       @"the primary foreground application is not the requested app");
  }
  NSString *startTime = RunnerSnapshotBridgeStartTime(pid);
  if (!startTime) {
    return RunnerSnapshotBridgeFailure(request, @"stale_target", @"target-process-unavailable",
                                       @"the foreground process exited before its identity was read");
  }
  process->pid = pid;
  process->startTime = startTime;
  return nil;
}

static NSDictionary *RunnerSnapshotBridgeTarget(NSString *bundleId, NSDictionary *request)
{
  RunnerSnapshotBridgeProcess process = {0, nil};
  NSDictionary *failure = RunnerSnapshotBridgeResolve(bundleId, request, &process);
  if (failure) return failure;
  NSString *requestId = [request[kRequestIdKey] isKindOfClass:NSString.class] ? request[kRequestIdKey] : @"";
  return @{
    kProtocolVersionKey : @(kProtocolVersion),
    kSourceVersionKey : kSourceVersion,
    kRequestIdKey : requestId,
    @"ok" : @YES,
    @"pid" : @(process.pid),
    @"processStartTime" : process.startTime,
  };
}

static NSDictionary *RunnerSnapshotBridgeDescribe(NSString *bundleId, NSDictionary *request)
{
  RunnerSnapshotBridgeProcess process = {0, nil};
  NSDictionary *failure = RunnerSnapshotBridgeResolve(bundleId, request, &process);
  if (failure) return failure;
  id expectedPid = request[@"expectedPid"];
  id expectedStartTime = request[@"expectedProcessStartTime"];
  if (([expectedPid isKindOfClass:NSNumber.class] && [expectedPid intValue] != process.pid) ||
      ([expectedStartTime isKindOfClass:NSString.class] && ![expectedStartTime isEqualToString:process.startTime])) {
    NSMutableDictionary *stale = [RunnerSnapshotBridgeFailure(request, @"stale_target", @"target-process-changed",
                                                              @"the foreground process of the app is a new process") mutableCopy];
    stale[@"observedPid"] = @(process.pid);
    stale[@"observedProcessStartTime"] = process.startTime;
    return stale;
  }
  NSMutableDictionary *describe = [request mutableCopy];
  [describe removeObjectsForKeys:@[ @"expectedPid", @"expectedProcessStartTime" ]];
  describe[@"pid"] = @(process.pid);
  NSMutableDictionary *response = [SnapshotBridgeHandleRequest(describe) mutableCopy];
  if (![RunnerSnapshotBridgeStartTime(process.pid) isEqualToString:process.startTime]) {
    return RunnerSnapshotBridgeFailure(request, @"stale_target", @"target-process-changed",
                                       @"the app's process changed while its tree was read");
  }
  response[@"processStartTime"] = process.startTime;
  return response;
}

/// The budget of a request that names none. The daemon names one on every request.
static const NSUInteger RunnerSnapshotBridgeDefaultBudgetMs = 3000;

static NSUInteger RunnerSnapshotBridgeBudgetMs(NSDictionary *request)
{
  NSNumber *budget = [request[@"maxDurationMs"] isKindOfClass:NSNumber.class] ? request[@"maxDurationMs"] : nil;
  if (budget.unsignedIntegerValue == 0) return RunnerSnapshotBridgeDefaultBudgetMs;
  return MIN(budget.unsignedIntegerValue, kMaximumDurationMs);
}

/// 1 while a read is admitted and has not returned, including a read abandoned past its budget: the
/// accessibility call it waits on cannot be cancelled, so later reads are refused until it returns
/// rather than queued behind it.
static atomic_int RunnerSnapshotBridgeReadsInFlight = 0;

static dispatch_queue_t RunnerSnapshotBridgeReaderQueue(void)
{
  static dispatch_queue_t queue;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    queue = dispatch_queue_create("com.callstack.agentdevice.runner.snapshot-bridge-reader",
                                  DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}

@interface RunnerSnapshotBridgeAnswer : NSObject
@property(atomic, strong, nullable) NSDictionary *value;
@end

@implementation RunnerSnapshotBridgeAnswer
@end

/// Runs one read on the reader queue and waits for it up to `budgetMs`. A read that outlives the budget
/// is abandoned, not stopped: its answer is dropped when it returns.
static NSDictionary *RunnerSnapshotBridgeRead(NSDictionary *request,
                                              NSUInteger budgetMs,
                                              NSDictionary * (^read)(void))
{
  // Admission is one atomic step, because requests arrive on a concurrent queue.
  int idle = 0;
  if (!atomic_compare_exchange_strong(&RunnerSnapshotBridgeReadsInFlight, &idle, 1)) {
    return RunnerSnapshotBridgeFailure(request, @"application_not_responding", @"bridge-read-in-flight",
                                       @"another accessibility read has not returned yet");
  }
  RunnerSnapshotBridgeAnswer *answer = [RunnerSnapshotBridgeAnswer new];
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  dispatch_async(RunnerSnapshotBridgeReaderQueue(), ^{
    @try {
      answer.value = read();
    } @catch (NSException *exception) {
      answer.value = RunnerSnapshotBridgeFailure(request, @"reader_unavailable", @"reader-exception",
                                                 exception.reason ?: @"the snapshot reader raised an exception");
    }
    atomic_store(&RunnerSnapshotBridgeReadsInFlight, 0);
    dispatch_semaphore_signal(done);
  });
  if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)budgetMs * NSEC_PER_MSEC)) != 0) {
    return RunnerSnapshotBridgeFailure(request, @"application_not_responding", @"bridge-read-abandoned",
                                       @"the accessibility read outlived its budget and was abandoned");
  }
  return answer.value;
}

uint32_t RunnerSnapshotBridgeMaximumFrameBytes(void)
{
  return kMaximumFrameBytes;
}

NSDictionary *RunnerSnapshotBridgeHandle(NSString *verb, NSString *bundleId, NSDictionary *request)
{
  if ([verb isEqualToString:@"target"]) {
    return RunnerSnapshotBridgeRead(request, RunnerSnapshotBridgeBudgetMs(request), ^{
      return RunnerSnapshotBridgeTarget(bundleId, request);
    });
  }
  if ([verb isEqualToString:@"describe"]) {
    return RunnerSnapshotBridgeRead(request, RunnerSnapshotBridgeBudgetMs(request), ^{
      return RunnerSnapshotBridgeDescribe(bundleId, request);
    });
  }
  return RunnerSnapshotBridgeFailure(request, @"bad_request", @"verb-not-supported",
                                     @"the runner snapshot bridge accepts target and describe requests only");
}

#else

uint32_t RunnerSnapshotBridgeMaximumFrameBytes(void)
{
  return 0;
}

NSDictionary *RunnerSnapshotBridgeHandle(NSString *verb, NSString *bundleId, NSDictionary *request)
{
  (void)verb;
  (void)bundleId;
  id requestId = request[@"requestId"];
  return @{
    @"requestId" : [requestId isKindOfClass:NSString.class] ? requestId : @"",
    @"ok" : @NO,
    @"error_kind" : @"unsupported",
    @"error_code" : @"runner-bridge-unavailable",
    @"error" : @"the runner serves the snapshot bridge on the iOS Simulator only",
  };
}

#endif
