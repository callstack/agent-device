// agent-device iOS Simulator network capture probe.
//
// Built at runtime by `packages/platform-apple/src/network/probe-cache.ts` and injected into the
// app under test through `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` (see ADR 0037). It replaces the
// implementation of `-[NSURLSessionTask resume]`, observes each task to completion, and appends one
// bounded JSON line per completed HTTP(S) task to the file named by
// `AGENT_DEVICE_NETWORK_CAPTURE_PATH`. Every request is read from the task itself, so a request that
// reused a keep-alive connection still carries its own full URL.
//
// The probe is a capture aid for simulator automation, not application code: it never blocks the
// app, never reads a response body, and exits silently whenever its environment is absent.
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <unistd.h>

// An upper bound on one line's header and error text, so one pathological response cannot grow the
// capture file without limit. The reader truncates again with its own budget.
static const NSUInteger AdMaxFieldChars = 8192;

// Credentials that must never reach the capture file, whatever the app put on the wire. The dump's
// --include headers mode would otherwise echo them (ADR 0037 rule 6).
static BOOL AdIsSensitiveHeader(NSString *name) {
  for (NSString *sensitive in @[
    @"Authorization", @"Proxy-Authorization", @"WWW-Authenticate", @"Proxy-Authenticate",
    @"Cookie", @"Set-Cookie",
  ]) {
    if ([name caseInsensitiveCompare:sensitive] == NSOrderedSame) return YES;
  }
  return NO;
}

static NSString *kAdOutputPath = nil;

// Bound on the capture file itself. The probe stops recording once the file reaches it, so a
// long-running session cannot grow the file without limit; the daemon's reader takes the newest
// window from the tail.
static const unsigned long long AdMaxFileBytes = 32 * 1024 * 1024;

static void AdWriteLine(NSString *line) {
  static NSFileHandle *handle = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *dir = [kAdOutputPath stringByDeletingLastPathComponent];
    [fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
    if (![fm fileExistsAtPath:kAdOutputPath]) {
      [fm createFileAtPath:kAdOutputPath contents:nil attributes:nil];
    }
    handle = [NSFileHandle fileHandleForWritingAtPath:kAdOutputPath];
    [handle seekToEndOfFile];
  });
  // `offsetInFile` raises when the seek underneath it fails (and is deprecated for exactly that
  // reason); `getOffset:error:` reports the same offset through an out-parameter (iOS 13+), so a
  // cap check on a handle whose offset cannot be read skips the write instead of raising in the
  // app under test (ADR 0037 rule 6).
  unsigned long long offset = 0;
  NSError *offsetError = nil;
  if (![handle getOffset:&offset error:&offsetError] || offsetError != nil) return;
  if (offset >= AdMaxFileBytes) return;
  // The error: form (available at the probe's iOS 15 floor): a plain writeData: raises an
  // Objective-C exception on ENOSPC, which would crash the app under test. A failed capture write
  // must never be the app's failure.
  NSError *error = nil;
  NSData *data = [[line stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
  [handle writeData:data error:&error];
}

static NSString *AdBound(NSString *value) {
  if (value.length <= AdMaxFieldChars) return value;
  return [value substringToIndex:AdMaxFieldChars];
}

static NSString *AdJsonString(NSString *value) {
  if (value == nil) return @"null";
  NSMutableString *out = [NSMutableString stringWithString:@"\""];
  for (NSUInteger i = 0; i < value.length; i++) {
    unichar c = [value characterAtIndex:i];
    switch (c) {
      case '"': [out appendString:@"\\\""]; break;
      case '\\': [out appendString:@"\\\\"]; break;
      case '\n': [out appendString:@"\\n"]; break;
      case '\r': [out appendString:@"\\r"]; break;
      case '\t': [out appendString:@"\\t"]; break;
      default:
        if (c < 0x20) [out appendFormat:@"\\u%04x", c];
        else [out appendFormat:@"%C", c];
    }
  }
  [out appendString:@"\""];
  return out;
}

// A JSON object literal, so the reader receives structured headers rather than one escaped string.
static NSString *AdJsonHeaders(NSDictionary<id, id> *headers) {
  if (headers.count == 0) return @"null";
  NSMutableArray<NSString *> *parts = [NSMutableArray array];
  for (id key in [headers.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
    NSString *name = [key description];
    if (AdIsSensitiveHeader(name)) {
      [parts addObject:[NSString stringWithFormat:@"%@: \"%@\"", AdJsonString(name), @"[REDACTED]"]];
      continue;
    }
    id value = headers[key];
    NSString *text = [value isKindOfClass:NSString.class] ? value : [value description];
    text = [text stringByReplacingOccurrencesOfString:@"\n" withString:@" "];
    [parts addObject:[NSString stringWithFormat:@"%@: %@",
                      AdJsonString(name),
                      AdJsonString(AdBound(text))]];
  }
  return [NSString stringWithFormat:@"{%@}", [parts componentsJoinedByString:@","]];
}

static void AdRecordCompletedTask(NSURLSessionTask *task, NSDate *startedAt) {
  NSURLRequest *request = task.currentRequest ?: task.originalRequest;
  if (request.URL.scheme.length > 0 &&
      !([request.URL.scheme caseInsensitiveCompare:@"http"] == NSOrderedSame ||
        [request.URL.scheme caseInsensitiveCompare:@"https"] == NSOrderedSame)) {
    return;
  }
  NSHTTPURLResponse *response = nil;
  if ([task.response isKindOfClass:NSHTTPURLResponse.class]) response = (id)task.response;
  NSNumber *duration = nil;
  if (startedAt) duration = @((long long)(-[startedAt timeIntervalSinceNow] * 1000));
  NSString *line = [NSString stringWithFormat:
      @"{\"method\":%@,\"url\":%@,\"status\":%@,\"duration_ms\":%@,"
       "\"timestamp_ms\":%@,\"sent\":%llu,\"recv\":%llu,\"error\":%@,"
       "\"request_headers\":%@,\"response_headers\":%@}",
      AdJsonString(request.HTTPMethod ?: @"GET"),
      AdJsonString(request.URL.absoluteString),
      response ? [NSString stringWithFormat:@"%ld", (long)response.statusCode] : @"null",
      duration ?: @"null",
      @((long long)([startedAt timeIntervalSince1970] * 1000)),
      task.countOfBytesSent,
      task.countOfBytesReceived,
      AdJsonString(AdBound(task.error.localizedDescription)),
      AdJsonHeaders(request.allHTTPHeaderFields),
      AdJsonHeaders(response.allHeaderFields)];
  AdWriteLine(line);
}

@interface AdTaskObserver : NSObject
@property(nonatomic, weak) NSURLSessionTask *task;
@property(nonatomic, strong) NSDate *startedAt;
@end

@implementation AdTaskObserver
- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey, id> *)change
                       context:(void *)context {
  NSURLSessionTask *task = self.task;
  if (task.state == NSURLSessionTaskStateCompleted) {
    AdRecordCompletedTask(task, self.startedAt);
    @try {
      [task removeObserver:self forKeyPath:@"state"];
    } @catch (NSException *exception) {
    }
  }
}
@end

static void (*ad_original_resume)(id, SEL) = nil;
static const void *kAdStartedKey = &kAdStartedKey;
static const void *kAdObserverKey = &kAdObserverKey;

static void ad_resume(id self, SEL _cmd) {
  ad_original_resume(self, _cmd);
  NSURLSessionTask *task = self;
  if (objc_getAssociatedObject(task, kAdStartedKey)) return;
  NSDate *startedAt = [NSDate date];
  objc_setAssociatedObject(task, kAdStartedKey, startedAt, OBJC_ASSOCIATION_RETAIN);
  AdTaskObserver *observer = [AdTaskObserver new];
  observer.task = task;
  observer.startedAt = startedAt;
  // The task owns the observer, so the KVO registration can never outlive the task it observes.
  objc_setAssociatedObject(task, kAdObserverKey, observer, OBJC_ASSOCIATION_RETAIN);
  @try {
    [task addObserver:observer forKeyPath:@"state" options:0 context:nil];
  } @catch (NSException *exception) {
    AdWriteLine([NSString stringWithFormat:@"{\"probe_error\":%@}",
                 AdJsonString(AdBound(exception.reason))]);
  }
}

__attribute__((constructor)) static void ad_network_capture_init(void) {
  kAdOutputPath = NSProcessInfo.processInfo.environment[@"AGENT_DEVICE_NETWORK_CAPTURE_PATH"];
  if (kAdOutputPath.length == 0) return;
  Class taskClass = NSClassFromString(@"NSURLSessionTask");
  if (taskClass == nil) return;
  Method resume = class_getInstanceMethod(taskClass, @selector(resume));
  if (resume == NULL) return;
  // One capture file per app process: a relaunch replaces the previous window's file rather than
  // appending to it, which keeps the file aligned with the session that launched this process.
  [[NSFileManager defaultManager] removeItemAtPath:kAdOutputPath error:nil];
  ad_original_resume = (void (*)(id, SEL))method_setImplementation(resume, (IMP)ad_resume);
}
