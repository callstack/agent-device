/*
 * Request validation for the private Simulator AX reader, shared by the guest server
 * (SnapshotBridge.m) and the XCTest runner, which serves the same reader without a guest process.
 */

#import "SnapshotBridgeRequest.h"
#import "SnapshotBridgeRuntime.h"
#import "SnapshotBridgeSurfaceHosts.h"

#import <limits.h>
#import <math.h>

NSDictionary *failureResponse(NSString *requestId,
                              NSString *kind,
                              NSString *code,
                              NSString *message)
{
  return @{
    kProtocolVersionKey : @(kProtocolVersion),
    kSourceVersionKey : kSourceVersion,
    kRequestIdKey : requestId ?: @"",
    @"ok" : @NO,
    @"error_kind" : kind ?: @"reader_unavailable",
    @"error_code" : code ?: @"unknown",
    @"error" : message ?: @"snapshot bridge request failed",
  };
}

static BOOL validBoundInteger(id value, NSUInteger minimum, NSUInteger maximum, NSUInteger *output)
{
  if (![value isKindOfClass:NSNumber.class]) return NO;
  NSNumber *number = value;
  // A JSON boolean is an NSNumber too, and must not pass as 0 or 1.
  if (CFGetTypeID((__bridge CFTypeRef)number) == CFBooleanGetTypeID()) return NO;
  if (number.doubleValue != floor(number.doubleValue)) return NO;
  if (number.unsignedIntegerValue < minimum || number.unsignedIntegerValue > maximum) return NO;
  if (output) *output = number.unsignedIntegerValue;
  return YES;
}

/*
 * A registered iOS system surface host (a web sign-in or Apple Pay sheet) presents out of the app's
 * process, and while it is up the app stays the primary accessibility owner, so this reader would
 * serve the occluded app tree as if healthy (#2438). When the host asks, the reader refuses the
 * capture while a host process runs for this Simulator. It reads the process table in place: a
 * spawned `pgrep` and `ps` cost each capture about 45ms (#2751).
 */
static NSString *const kSurfaceHostExecutablesKey = @"surfaceHostExecutables";
static NSString *const kSimulatorUdidKey = @"simulatorUdid";
static NSString *const kSurfaceHostExecutableKey = @"surfaceHostExecutable";
static const NSUInteger kMaximumSurfaceHosts = 8;
static const NSUInteger kMaximumSurfaceHostExecutableLength = 256;
static const NSUInteger kMaximumSimulatorUdidLength = 64;

/* The refusal for a capture a running surface host may cover, or nil when none runs. */
static NSDictionary *_Nullable captureRefusalForSurfaceHosts(NSArray<NSString *> *executables,
                                                             NSString *simulatorUdid,
                                                             NSString *requestId)
{
  BOOL unverified = NO;
  NSString *running = runningSurfaceHost(executables, simulatorUdid, &unverified);
  if (running) {
    NSMutableDictionary *refusal = [failureResponse(requestId, @"unsupported", @"system-surface-host-present",
        @"a system surface host is running for this Simulator") mutableCopy];
    refusal[kSurfaceHostExecutableKey] = running;
    return refusal;
  }
  if (unverified) {
    return failureResponse(requestId, @"unsupported", @"system-surface-host-unverified",
        @"a system surface host process could not be placed on this Simulator");
  }
  return nil;
}

/* The requested surface host check: nil when the request asks for none, NSNull when malformed. */
static id surfaceHostExecutables(NSDictionary *request)
{
  id value = request[kSurfaceHostExecutablesKey];
  if (value == nil) return nil;
  if (![value isKindOfClass:NSArray.class] || [value count] == 0 || [value count] > kMaximumSurfaceHosts) {
    return NSNull.null;
  }
  for (id executable in value) {
    if (![executable isKindOfClass:NSString.class] || [executable length] == 0 ||
        [executable length] > kMaximumSurfaceHostExecutableLength) {
      return NSNull.null;
    }
  }
  return value;
}

static NSDictionary *withTargetIdentity(NSDictionary *response, NSNumber *pid, NSString *generation)
{
  NSMutableDictionary *annotated = [response mutableCopy];
  annotated[@"pid"] = pid;
  annotated[@"generation"] = generation;
  return annotated;
}

NSDictionary *SnapshotBridgeHandleRequest(NSDictionary *request)
{
  NSString *requestId = [request[kRequestIdKey] isKindOfClass:NSString.class] ? request[kRequestIdKey] : @"";
  id verb = request[@"verb"];
  if (![verb isKindOfClass:NSString.class] || ![verb isEqualToString:@"describe"]) {
    return failureResponse(requestId, @"bad_request", @"verb-not-supported", @"snapshot bridge accepts describe requests only");
  }
  NSNumber *pidValue = request[@"pid"];
  if (!validBoundInteger(pidValue, 1, INT_MAX, NULL)) {
    return failureResponse(requestId, @"bad_request", @"pid-required", @"describe requires a positive target pid");
  }
  NSString *generation = [request[@"generation"] isKindOfClass:NSString.class] ? request[@"generation"] : @"";
  if (generation.length == 0) {
    return failureResponse(requestId, @"bad_request", @"generation-required", @"describe requires an opaque target generation");
  }
  id snapshotTree = request[@"snapshotTree"];
  if (![snapshotTree isKindOfClass:NSNumber.class] || ![snapshotTree boolValue]) {
    return failureResponse(requestId, @"bad_request", @"snapshot-tree-required", @"snapshotTree must be enabled");
  }
  id automationMode = request[@"automationMode"];
  if (![automationMode isKindOfClass:NSNumber.class] || ![automationMode boolValue]) {
    return failureResponse(requestId, @"bad_request", @"automation-mode-required", @"automationMode must be enabled");
  }
  NSUInteger maxDepth = 0;
  NSUInteger maxNodes = 0;
  NSUInteger maxDurationMs = 0;
  NSUInteger maxResponseBytes = 0;
  if (!validBoundInteger(request[@"maxDepth"], 0, kMaximumDepth, &maxDepth) ||
      !validBoundInteger(request[@"maxNodes"], 1, kMaximumNodes, &maxNodes) ||
      !validBoundInteger(request[@"maxDurationMs"], 1, kMaximumDurationMs, &maxDurationMs) ||
      !validBoundInteger(request[@"maxResponseBytes"], 1024, kMaximumFrameBytes, &maxResponseBytes)) {
    return failureResponse(requestId, @"bad_request", @"bounds-invalid", @"snapshot bridge request bounds are outside the bridge limits");
  }
  NSUInteger nativeLevelsHint = 0;
  if (request[@"nativeLevelsHint"] != nil &&
      !validBoundInteger(request[@"nativeLevelsHint"], 1, kMaximumDepth + 1, &nativeLevelsHint)) {
    return failureResponse(requestId, @"bad_request", @"bounds-invalid", @"nativeLevelsHint is outside the bridge depth limits");
  }
  id surfaceHosts = surfaceHostExecutables(request);
  NSString *simulatorUdid = [request[kSimulatorUdidKey] isKindOfClass:NSString.class] ? request[kSimulatorUdidKey] : @"";
  if (surfaceHosts == NSNull.null ||
      (surfaceHosts && (simulatorUdid.length == 0 || simulatorUdid.length > kMaximumSimulatorUdidLength))) {
    return failureResponse(requestId, @"bad_request", @"surface-hosts-invalid", @"surfaceHostExecutables needs bounded executable names and a simulatorUdid");
  }
  if (surfaceHosts) {
    NSDictionary *refusal = captureRefusalForSurfaceHosts(surfaceHosts, simulatorUdid, requestId);
    if (refusal) return withTargetIdentity(refusal, pidValue, generation);
  }

  NSString *setupError = nil;
  BridgeRuntime *runtime = sharedRuntime(&setupError);
  if (!runtime) {
    NSMutableDictionary *unavailable = [failureResponse(requestId, @"unsupported", @"runtime-unavailable", setupError) mutableCopy];
    unavailable[@"pid"] = pidValue;
    unavailable[@"generation"] = generation;
    return unavailable;
  }
  NSDictionary *error = nil;
  NSDictionary *response = [runtime snapshotForProcess:pidValue.intValue
                                               maxDepth:maxDepth
                                               maxNodes:maxNodes
                                       nativeLevelsHint:nativeLevelsHint
                                             requestId:requestId
                                           generation:generation
                                         maxDurationMs:maxDurationMs
                                                 error:&error];
  if (response && surfaceHosts) {
    // A sheet presented during the capture covers what it read.
    NSDictionary *refusal = captureRefusalForSurfaceHosts(surfaceHosts, simulatorUdid, requestId);
    if (refusal) return withTargetIdentity(refusal, pidValue, generation);
  }
  if (response) return response;
  if (error) return withTargetIdentity(error, pidValue, generation);
  return failureResponse(requestId, @"reader_unavailable", @"empty-response", @"AX bridge returned no response");
}
