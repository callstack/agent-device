// The runner host app's UIKit view controller, shared by the two source units that draw it.
// AgentDeviceRunnerApp.m implements the screen the npm package ships;
// AgentDeviceRunnerAppFixtures.m subclasses it for the unit-test build only and is dropped from
// the package. A packaged build compiles this header with the fixtures file absent, so nothing
// here may name fixture code.
#import <TargetConditionals.h>

#if !TARGET_OS_OSX
#import <UIKit/UIKit.h>

@interface AgentDeviceRunnerViewController : UIViewController

// The host's own title label. The fixture screens lay out against it, so the unit-test host keeps
// the anchors the shipped host draws.
@property(nonatomic, strong, readonly) UILabel *label;

// The one extension point between the shipped host and the fixture host: called after the window
// carries its root view controller and before it is shown, so a fixture window an override adds
// stays behind the main window, as before. The shipped host does nothing here.
- (void)agentDeviceWillAttachToWindow:(UIWindow *)window;

@end

#endif
