#import "RunnerObjCExceptionCatcher.h"
#import "RunnerAXSnapshotBridge.h"
#import "RunnerSimulatorEdgeTouch.h"
#import "RunnerSnapshotBridge.h"
#import "RunnerSynthesizedGesture.h"
#import "RunnerSynthesizedTextEntry.h"
#import "RunnerXCTestEventBridge.h"
// The packaged runner omits UnitTests/. OTHER_CFLAGS defines do not reach this header.
#if __has_include("UnitTests/RunnerAXModalScopeCapture.h")
#import "UnitTests/RunnerAXModalScopeCapture.h"
#endif
#if __has_include("UnitTests/RunnerEdgeContactTesting.h")
#import "UnitTests/RunnerEdgeContactTesting.h"
#endif
