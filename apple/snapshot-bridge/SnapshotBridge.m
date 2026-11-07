/*
 * The framed server for the private Simulator AX reader. Request validation is in
 * SnapshotBridgeRequest.m and the runtime binding in SnapshotBridgeRuntime.m.
 */

#import "SnapshotBridgeRequest.h"
#import "SnapshotBridgeRuntime.h"

#import <Foundation/Foundation.h>

#import <arpa/inet.h>
#import <errno.h>
#import <limits.h>
#import <math.h>
#import <poll.h>
#import <sys/socket.h>
#import <sys/stat.h>
#import <sys/types.h>
#import <sys/un.h>
#import <unistd.h>

static const int kDefaultIdleTimeoutSeconds = 60;

static void bridgeLog(NSString *message)
{
  fprintf(stderr, "[agent-device-snapshot-bridge] %s\n", message.UTF8String ?: "(no message)");
  fflush(stderr);
}

static BOOL readFully(int fd, void *buffer, size_t length)
{
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = recv(fd, (char *)buffer + offset, length - offset, 0);
    if (count > 0) {
      offset += (size_t)count;
      continue;
    }
    if (count < 0 && errno == EINTR) continue;
    return NO;
  }
  return YES;
}

static BOOL writeFully(int fd, const void *buffer, size_t length)
{
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = send(fd, (const char *)buffer + offset, length - offset, MSG_NOSIGNAL);
    if (count > 0) {
      offset += (size_t)count;
      continue;
    }
    if (count < 0 && errno == EINTR) continue;
    return NO;
  }
  return YES;
}

static NSData *serializedResponse(NSDictionary *response, NSUInteger maxResponseBytes)
{
  NSError *error = nil;
  NSData *data = nil;
  @try {
    data = [NSJSONSerialization dataWithJSONObject:response options:0 error:&error];
    if (data && data.length + sizeof(uint32_t) <= maxResponseBytes) return data;
  } @catch (NSException *exception) {
    bridgeLog(exception.reason ?: @"response serialization raised an exception");
  }
  NSMutableDictionary *fallback = [failureResponse(
      response[kRequestIdKey],
      data ? @"response_limit_exceeded" : @"malformed_tree",
      data ? @"response-too-large" : @"response-not-json-safe",
      data ? @"snapshot response exceeds the per-request response bound" : (error.localizedDescription ?: @"response was not JSON serializable")) mutableCopy];
  if (response[@"pid"] != nil) fallback[@"pid"] = response[@"pid"];
  if (response[@"generation"] != nil) fallback[@"generation"] = response[@"generation"];
  return [NSJSONSerialization dataWithJSONObject:fallback options:0 error:NULL];
}

static NSUInteger responseLimitForRequest(id request)
{
  if (![request isKindOfClass:NSDictionary.class]) return kMaximumFrameBytes;
  NSNumber *value = request[@"maxResponseBytes"];
  if (![value isKindOfClass:NSNumber.class]) return kMaximumFrameBytes;
  NSUInteger result = value.unsignedIntegerValue;
  return result >= 1024 && result <= kMaximumFrameBytes ? result : kMaximumFrameBytes;
}

static int serve(NSString *socketPath, int idleTimeoutSeconds, BOOL exitOnDisconnect)
{
  if (socketPath.length == 0 || socketPath.length >= sizeof(((struct sockaddr_un *)0)->sun_path)) {
    bridgeLog(@"socket path is empty or too long");
    return 1;
  }

  int listener = socket(AF_UNIX, SOCK_STREAM, 0);
  if (listener < 0) {
    bridgeLog([NSString stringWithFormat:@"socket failed: %s", strerror(errno)]);
    return 1;
  }
  struct sockaddr_un address = {0};
  address.sun_family = AF_UNIX;
  strlcpy(address.sun_path, socketPath.fileSystemRepresentation, sizeof(address.sun_path));
  unlink(address.sun_path);
  if (bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0 || listen(listener, 4) != 0) {
    bridgeLog([NSString stringWithFormat:@"bind/listen failed for %@: %s", socketPath, strerror(errno)]);
    close(listener);
    return 1;
  }
  chmod(address.sun_path, S_IRUSR | S_IWUSR);
  bridgeLog([NSString stringWithFormat:@"serving protocol %lu on %@", (unsigned long)kProtocolVersion, socketPath]);

  BOOL done = NO;
  while (!done) {
    struct pollfd waitForClient = {.fd = listener, .events = POLLIN, .revents = 0};
    int ready = poll(&waitForClient, 1, idleTimeoutSeconds * 1000);
    if (ready == 0) break;
    if (ready < 0) {
      if (errno == EINTR) continue;
      break;
    }
    int connection = accept(listener, NULL, NULL);
    if (connection < 0) {
      if (errno == EINTR) continue;
      break;
    }
    struct timeval timeout = {.tv_sec = idleTimeoutSeconds, .tv_usec = 0};
    setsockopt(connection, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(connection, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    while (YES) {
      @autoreleasepool {
        uint32_t networkLength = 0;
        if (!readFully(connection, &networkLength, sizeof(networkLength))) break;
        uint32_t length = ntohl(networkLength);
        if (length == 0 || length > kMaximumFrameBytes) break;
        NSMutableData *body = [NSMutableData dataWithLength:length];
        if (!readFully(connection, body.mutableBytes, length)) break;
        id parsed = [NSJSONSerialization JSONObjectWithData:body options:0 error:NULL];
        NSDictionary *response = [parsed isKindOfClass:NSDictionary.class]
            ? SnapshotBridgeHandleRequest(parsed)
            : failureResponse(@"", @"bad_request", @"json-object-required", @"request frame must be a JSON object");
        NSData *encoded = serializedResponse(response, responseLimitForRequest(parsed));
        if (encoded.length > kMaximumFrameBytes) break;
        uint32_t responseLength = htonl((uint32_t)encoded.length);
        if (!writeFully(connection, &responseLength, sizeof(responseLength)) ||
            !writeFully(connection, encoded.bytes, encoded.length)) break;
      }
    }
    close(connection);
    if (exitOnDisconnect) done = YES;
  }

  close(listener);
  unlink(address.sun_path);
  return 0;
}

static int integerArgument(NSArray<NSString *> *arguments, NSString *flag, int fallback)
{
  for (NSUInteger index = 0; index + 1 < arguments.count; index += 1) {
    if (![arguments[index] isEqualToString:flag]) continue;
    NSInteger value = arguments[index + 1].integerValue;
    if (value > 0 && value <= INT_MAX) return (int)value;
  }
  return fallback;
}

static BOOL boolArgument(NSArray<NSString *> *arguments, NSString *flag, BOOL fallback)
{
  for (NSUInteger index = 0; index + 1 < arguments.count; index += 1) {
    if ([arguments[index] isEqualToString:flag]) return [arguments[index + 1] boolValue];
  }
  return fallback;
}

int main(int argc, const char *argv[])
{
  @autoreleasepool {
    if (argc < 3 || strcmp(argv[1], "serve") != 0) {
      fprintf(stderr, "Usage: %s serve <socket> [--idle-timeout <seconds>] [--exit-on-disconnect <bool>]\n", argv[0]);
      return 2;
    }
    NSMutableArray<NSString *> *arguments = [NSMutableArray array];
    for (int index = 2; index < argc; index += 1) {
      NSString *value = [NSString stringWithUTF8String:argv[index]];
      if (value) [arguments addObject:value];
    }
    NSString *socketPath = arguments.firstObject;
    if (socketPath.length == 0) return 2;
    NSArray<NSString *> *flags = [arguments subarrayWithRange:NSMakeRange(1, arguments.count - 1)];
    return serve(socketPath,
                 integerArgument(flags, @"--idle-timeout", kDefaultIdleTimeoutSeconds),
                 boolArgument(flags, @"--exit-on-disconnect", YES));
  }
}
