#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <TargetConditionals.h>

NS_ASSUME_NONNULL_BEGIN

#if TARGET_OS_IOS && TARGET_OS_SIMULATOR

typedef CFTypeRef RunnerHIDEventRef;
typedef RunnerHIDEventRef _Nullable (*RunnerCreateDigitizerEvent)(
  CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, double, double,
  double, double, double, Boolean, Boolean, uint32_t);
typedef RunnerHIDEventRef _Nullable (*RunnerCreateDigitizerFingerEvent)(
  CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t, double, double, double, double, double,
  Boolean, Boolean, uint32_t);
typedef void (*RunnerAppendEvent)(RunnerHIDEventRef, RunnerHIDEventRef, uint32_t);
typedef void (*RunnerSetIntegerValue)(RunnerHIDEventRef, uint32_t, long);
typedef void (*RunnerSetFloatValue)(RunnerHIDEventRef, uint32_t, double);
typedef void (*RunnerSetSenderID)(RunnerHIDEventRef, uint64_t);
typedef void (*RunnerSetTimeStamp)(RunnerHIDEventRef, uint64_t);
typedef CFTypeRef _Nullable (*RunnerCreateEventSystemClient)(CFAllocatorRef);
typedef CFArrayRef _Nullable (*RunnerCopyServices)(CFTypeRef);
typedef CFTypeRef _Nullable (*RunnerCopyServiceProperty)(CFTypeRef, CFStringRef);
typedef CFTypeRef _Nullable (*RunnerGetServiceRegistryID)(CFTypeRef);
typedef void (*RunnerDispatchEvent)(CFTypeRef, RunnerHIDEventRef);

// The IOKit HID entry points the edge touch uses, resolved at run time.
typedef struct {
  RunnerCreateDigitizerEvent createDigitizerEvent;
  RunnerCreateDigitizerFingerEvent createFingerEvent;
  RunnerAppendEvent appendEvent;
  RunnerSetIntegerValue setIntegerValue;
  RunnerSetFloatValue setFloatValue;
  RunnerSetSenderID setSenderID;
  RunnerSetTimeStamp setTimeStamp;
  RunnerCreateEventSystemClient createClient;
  RunnerCopyServices copyServices;
  RunnerCopyServiceProperty copyServiceProperty;
  RunnerGetServiceRegistryID getServiceRegistryID;
  RunnerDispatchEvent dispatchEvent;
} RunnerHIDFunctions;

// Owns one edge contact from touch-down to its terminal event. The cancel event is built before
// touch-down; after touch-down, every exit dispatches either the touch-up or that cancel event.
// Returns nil on success, or the reason the contact did not complete.
FOUNDATION_EXPORT NSString * _Nullable RunnerDispatchEdgeContact(
  const RunnerHIDFunctions *functions,
  CFTypeRef client,
  uint64_t sender,
  NSArray<NSDictionary<NSString *, NSNumber *> *> *samples,
  CGSize screenSize
);

#endif

NS_ASSUME_NONNULL_END
