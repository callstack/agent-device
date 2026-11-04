#if defined(AGENT_DEVICE_RUNNER_UNIT_TESTS)
#import "RunnerEdgeContactTesting.h"

#if TARGET_OS_IOS && TARGET_OS_SIMULATOR

#import "RunnerSimulatorEdgeContact.h"

static NSInteger RunnerTestingFailingFrame;
static NSInteger RunnerTestingCreatedFrames;
static NSMutableArray<NSDictionary<NSString *, NSNumber *> *> *RunnerTestingDispatched;

static RunnerHIDEventRef RunnerTestingCreateHand(
  CFAllocatorRef allocator, uint64_t timestamp, uint32_t transducer, uint32_t index, uint32_t identity,
  uint32_t mask, uint32_t buttons, double x, double y, double z, double tip, double barrel,
  Boolean range, Boolean touch, uint32_t options
) {
  NSInteger frame = RunnerTestingCreatedFrames++;
  if (RunnerTestingFailingFrame >= 0 && frame >= RunnerTestingFailingFrame) return NULL;
  NSMutableDictionary *event = [@{ @"mask": @(mask), @"touching": @(touch), @"restamped": @NO } mutableCopy];
  return CFBridgingRetain(event);
}

static RunnerHIDEventRef RunnerTestingCreateFinger(
  CFAllocatorRef allocator, uint64_t timestamp, uint32_t index, uint32_t identity, uint32_t mask,
  double x, double y, double z, double tip, double twist, Boolean range, Boolean touch, uint32_t options
) {
  return CFBridgingRetain([NSMutableDictionary dictionary]);
}

static void RunnerTestingAppend(RunnerHIDEventRef parent, RunnerHIDEventRef child, uint32_t options) {}
static void RunnerTestingSetInteger(RunnerHIDEventRef event, uint32_t field, long value) {}
static void RunnerTestingSetFloat(RunnerHIDEventRef event, uint32_t field, double value) {}
static void RunnerTestingSetSender(RunnerHIDEventRef event, uint64_t sender) {}

static void RunnerTestingSetTimeStamp(RunnerHIDEventRef event, uint64_t timestamp) {
  ((__bridge NSMutableDictionary *)event)[@"restamped"] = @YES;
}

static void RunnerTestingDispatch(CFTypeRef client, RunnerHIDEventRef event) {
  [RunnerTestingDispatched addObject:[(__bridge NSDictionary *)event copy]];
}

NSArray<NSDictionary<NSString *, NSNumber *> *> *RunnerEdgeContactDispatches(
  NSInteger failingFrame,
  NSString **failure
) {
  RunnerTestingFailingFrame = failingFrame;
  RunnerTestingCreatedFrames = 0;
  RunnerTestingDispatched = [NSMutableArray array];
  RunnerHIDFunctions functions = {
    .createDigitizerEvent = RunnerTestingCreateHand,
    .createFingerEvent = RunnerTestingCreateFinger,
    .appendEvent = RunnerTestingAppend,
    .setIntegerValue = RunnerTestingSetInteger,
    .setFloatValue = RunnerTestingSetFloat,
    .setSenderID = RunnerTestingSetSender,
    .setTimeStamp = RunnerTestingSetTimeStamp,
    .dispatchEvent = RunnerTestingDispatch,
  };
  NSArray *samples = @[
    @{ @"x": @0, @"y": @50, @"offsetMs": @0 },
    @{ @"x": @100, @"y": @50, @"offsetMs": @48 },
  ];
  NSString *result = RunnerDispatchEdgeContact(&functions, (__bridge CFTypeRef)samples, 1, samples, CGSizeMake(100, 100));
  if (failure != NULL) *failure = result;
  return [RunnerTestingDispatched copy];
}

#endif
#endif
