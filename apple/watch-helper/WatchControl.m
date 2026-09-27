#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <dlfcn.h>
#import <mach/mach_time.h>
#import <unistd.h>

// Isolated host-side CoreSimulator input helper. The helper loads only the active Xcode's private
// frameworks, resolves every symbol dynamically, and exits after one verified transport send.
// The Indigo protocol and doubled contact shape follow Meta idb's MIT-licensed Simulator HID
// contract; no private framework header is compiled into the package.

typedef void *(*MouseMessageFn)(CGPoint *, CGPoint *, NSInteger, NSUInteger, CGSize, NSInteger);
typedef void *(*ButtonMessageFn)(int, int, int);
typedef void *(*CrownMessageFn)(double);

static const size_t kHeaderSize = 0x20;
static const size_t kPayloadSize = 0x90;
static const size_t kDoubledTouchSize = 0x140;
static const NSInteger kDigitizerTarget = 0x32;
static const int kHardwareTarget = 0x33;
static const int kButtonDown = 1;
static const int kButtonUp = 2;
static const int kHomeButtonSource = 0;

static void fail(NSString *message) {
  fprintf(stderr, "%s\n", message.UTF8String);
}

static BOOL loadFramework(NSArray<NSString *> *candidates) {
  for (NSString *path in candidates) {
    if (dlopen(path.fileSystemRepresentation, RTLD_LAZY | RTLD_GLOBAL)) return YES;
  }
  return NO;
}

static NSString *developerDirectory(void) {
  NSString *selected = NSProcessInfo.processInfo.environment[@"DEVELOPER_DIR"];
  if (selected.length > 0) return selected.stringByStandardizingPath;
  NSTask *task = [NSTask new];
  task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/xcode-select"];
  task.arguments = @[@"-p"];
  NSPipe *pipe = [NSPipe pipe];
  task.standardOutput = pipe;
  task.standardError = [NSPipe pipe];
  if (![task launchAndReturnError:NULL]) return @"";
  [task waitUntilExit];
  NSData *data = [pipe.fileHandleForReading readDataToEndOfFile];
  NSString *value = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"";
  return [value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

static BOOL loadPrivateFrameworks(NSString *developerDir) {
  NSString *contents = developerDir.stringByDeletingLastPathComponent;
  NSArray *coreSimulator = @[
    [developerDir stringByAppendingPathComponent:@"Library/PrivateFrameworks/CoreSimulator.framework/CoreSimulator"],
    @"/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
  ];
  NSArray *simulatorKit = @[
    [developerDir stringByAppendingPathComponent:@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"],
    [contents stringByAppendingPathComponent:@"SharedFrameworks/SimulatorKit.framework/SimulatorKit"],
    @"/Library/Developer/PrivateFrameworks/SimulatorKit.framework/SimulatorKit",
  ];
  return loadFramework(coreSimulator) && loadFramework(simulatorKit);
}

static id simulatorDevice(NSString *developerDir, NSString *udid, NSError **error) {
  Class contextClass = NSClassFromString(@"SimServiceContext");
  SEL shared = NSSelectorFromString(@"sharedServiceContextForDeveloperDir:error:");
  id context = ((id (*)(id, SEL, id, NSError **))objc_msgSend)(contextClass, shared, developerDir, error);
  if (!context) return nil;
  SEL defaultSet = NSSelectorFromString(@"defaultDeviceSetWithError:");
  id deviceSet = ((id (*)(id, SEL, NSError **))objc_msgSend)(context, defaultSet, error);
  if (!deviceSet) return nil;
  NSArray *devices = ((id (*)(id, SEL))objc_msgSend)(deviceSet, NSSelectorFromString(@"devices"));
  for (id device in devices) {
    NSUUID *identifier = ((id (*)(id, SEL))objc_msgSend)(device, NSSelectorFromString(@"UDID"));
    if ([identifier.UUIDString caseInsensitiveCompare:udid] == NSOrderedSame) return device;
  }
  return nil;
}

static id hidClient(id device, NSError **error) {
  Class clientClass = NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient");
  if (!clientClass) return nil;
  id allocated = ((id (*)(id, SEL))objc_msgSend)(clientClass, sel_registerName("alloc"));
  return ((id (*)(id, SEL, id, NSError **))objc_msgSend)(
      allocated, NSSelectorFromString(@"initWithDevice:error:"), device, error);
}

static BOOL sendMessage(id client, void *message, NSError **error) {
  if (!message) return NO;
  dispatch_queue_t queue = dispatch_queue_create("agent-device.watch-hid", DISPATCH_QUEUE_SERIAL);
  dispatch_semaphore_t finished = dispatch_semaphore_create(0);
  __block NSError *completionError = nil;
  void (^completion)(NSError *) = ^(NSError *inner) {
    completionError = inner;
    dispatch_semaphore_signal(finished);
  };
  SEL send = NSSelectorFromString(@"sendWithMessage:freeWhenDone:completionQueue:completion:");
  ((void (*)(id, SEL, void *, BOOL, dispatch_queue_t, id))objc_msgSend)(
      client, send, message, YES, queue, completion);
  if (dispatch_semaphore_wait(finished, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC)) != 0) {
    if (error) *error = [NSError errorWithDomain:@"agent-device.watch-hid" code:1
      userInfo:@{NSLocalizedDescriptionKey: @"Simulator HID send timed out"}];
    return NO;
  }
  if (completionError && error) *error = completionError;
  return completionError == nil;
}

static void *touchMessage(MouseMessageFn builder, double x, double y, int phase) {
  CGPoint point = CGPointMake(x, y);
  void *base = builder(&point, NULL, kDigitizerTarget, phase, CGSizeMake(1, 1), 0);
  if (!base) return NULL;
  uint8_t *message = calloc(1, kDoubledTouchSize);
  memcpy(message, base, kHeaderSize + kPayloadSize);
  free(base);
  *(uint32_t *)(message + 0x18) = (uint32_t)kPayloadSize;
  message[0x1c] = 2;
  *(uint32_t *)(message + 0x20) = 0x0b;
  *(uint64_t *)(message + 0x24) = mach_absolute_time();
  *(double *)(message + 0x3c) = x;
  *(double *)(message + 0x44) = y;
  memcpy(message + kHeaderSize + kPayloadSize, message + kHeaderSize, kPayloadSize);
  uint8_t *secondEvent = message + kHeaderSize + kPayloadSize + 0x10;
  *(uint32_t *)(secondEvent + 0) = 1;
  *(uint32_t *)(secondEvent + 4) = 2;
  return message;
}

static BOOL sendTouch(id client, MouseMessageFn builder, double x, double y, int phase, NSError **error) {
  return sendMessage(client, touchMessage(builder, x, y, phase), error);
}

static BOOL tap(id client, MouseMessageFn builder, double x, double y, NSError **error) {
  if (!sendTouch(client, builder, x, y, kButtonDown, error)) return NO;
  usleep(60 * 1000);
  return sendTouch(client, builder, x, y, kButtonUp, error);
}

static BOOL swipe(id client, MouseMessageFn builder, double x1, double y1, double x2, double y2,
    NSUInteger durationMs, NSError **error) {
  NSUInteger frames = MAX(2, MIN(120, durationMs / 16));
  for (NSUInteger index = 0; index <= frames; index++) {
    double progress = (double)index / (double)frames;
    if (!sendTouch(client, builder, x1 + (x2 - x1) * progress,
        y1 + (y2 - y1) * progress, kButtonDown, error)) return NO;
    usleep((useconds_t)(durationMs * 1000 / frames));
  }
  return sendTouch(client, builder, x2, y2, kButtonUp, error);
}

static BOOL pressCrown(id client, ButtonMessageFn builder, NSError **error) {
  if (!sendMessage(client, builder(kHomeButtonSource, kButtonDown, kHardwareTarget), error)) return NO;
  usleep(50 * 1000);
  return sendMessage(client, builder(kHomeButtonSource, kButtonUp, kHardwareTarget), error);
}

static BOOL readDouble(NSString *value, double minimum, double maximum, double *output) {
  NSScanner *scanner = [NSScanner scannerWithString:value];
  double number = 0;
  if (![scanner scanDouble:&number] || !scanner.isAtEnd || !isfinite(number) ||
      number < minimum || number > maximum) return NO;
  *output = number;
  return YES;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 3) return 2;
    NSString *developerDir = developerDirectory();
    if (!loadPrivateFrameworks(developerDir)) {
      fail(@"CoreSimulator or SimulatorKit could not be loaded from the selected Xcode");
      return 1;
    }
    NSError *error = nil;
    id device = simulatorDevice(developerDir, @(argv[1]), &error);
    id client = device ? hidClient(device, &error) : nil;
    if (!client) {
      fail(error.localizedDescription ?: @"Watch Simulator HID client is unavailable");
      return 1;
    }
    MouseMessageFn mouse = (MouseMessageFn)dlsym(RTLD_DEFAULT, "IndigoHIDMessageForMouseNSEvent");
    ButtonMessageFn button = (ButtonMessageFn)dlsym(RTLD_DEFAULT, "IndigoHIDMessageForButton");
    CrownMessageFn crown = (CrownMessageFn)dlsym(RTLD_DEFAULT, "IndigoHIDMessageForDigitalCrownEvent");
    NSString *command = @(argv[2]);
    BOOL sent = NO;
    if ([command isEqual:@"tap"] && argc == 5 && mouse) {
      double x = 0, y = 0;
      sent = readDouble(@(argv[3]), 0, 1, &x) && readDouble(@(argv[4]), 0, 1, &y) &&
          tap(client, mouse, x, y, &error);
    } else if ([command isEqual:@"swipe"] && argc == 8 && mouse) {
      double x1 = 0, y1 = 0, x2 = 0, y2 = 0, duration = 0;
      sent = readDouble(@(argv[3]), 0, 1, &x1) && readDouble(@(argv[4]), 0, 1, &y1) &&
          readDouble(@(argv[5]), 0, 1, &x2) && readDouble(@(argv[6]), 0, 1, &y2) &&
          readDouble(@(argv[7]), 50, 5000, &duration) &&
          swipe(client, mouse, x1, y1, x2, y2, (NSUInteger)duration, &error);
    } else if ([command isEqual:@"crown-scroll"] && argc == 4 && crown) {
      double delta = 0;
      sent = readDouble(@(argv[3]), -10000, 10000, &delta) &&
          sendMessage(client, crown(delta), &error);
    } else if ([command isEqual:@"crown-press"] && argc == 3 && button) {
      sent = pressCrown(client, button, &error);
    }
    if (!sent) fail(error.localizedDescription ?: @"Invalid or unsupported watch HID command");
    return sent ? 0 : 2;
  }
}
