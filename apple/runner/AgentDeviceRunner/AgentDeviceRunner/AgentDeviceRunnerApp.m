#import <TargetConditionals.h>
#if TARGET_OS_OSX
#import <Cocoa/Cocoa.h>

@interface AgentDeviceRunnerAppDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSWindow *window;
@end

@implementation AgentDeviceRunnerAppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;

  NSRect frame = NSMakeRect(0, 0, 360, 220);
  self.window = [[NSWindow alloc] initWithContentRect:frame
                                            styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                                       NSWindowStyleMaskMiniaturizable)
                                              backing:NSBackingStoreBuffered
                                                defer:NO];
  self.window.title = @"Agent Device Runner";

  NSTextField *label = [NSTextField labelWithString:@"Agent Device Runner"];
  label.font = [NSFont systemFontOfSize:20 weight:NSFontWeightSemibold];
  label.translatesAutoresizingMaskIntoConstraints = NO;

  NSView *contentView = [[NSView alloc] initWithFrame:frame];
  [contentView addSubview:label];
  self.window.contentView = contentView;

  [NSLayoutConstraint activateConstraints:@[
    [label.centerXAnchor constraintEqualToAnchor:contentView.centerXAnchor],
    [label.centerYAnchor constraintEqualToAnchor:contentView.centerYAnchor],
  ]];

  [self.window center];
  [self.window makeKeyAndOrderFront:nil];
}

@end

int main(int argc, const char *argv[]) {
  (void)argc;
  (void)argv;

  @autoreleasepool {
    NSApplication *application = [NSApplication sharedApplication];
    AgentDeviceRunnerAppDelegate *delegate = [[AgentDeviceRunnerAppDelegate alloc] init];
    application.delegate = delegate;
    [application setActivationPolicy:NSApplicationActivationPolicyRegular];
    [application run];
  }

  return 0;
}

#else
#import "AgentDeviceRunnerApp.h"
#import <UIKit/UIKit.h>

// The runner host app ships in the npm package and carries no fixture code. Every
// `--agent-device-*` fixture screen lives in AgentDeviceRunnerAppFixtures.m, compiled
// only under AGENT_DEVICE_RUNNER_UNIT_TESTS and dropped from the package by
// scripts/package-apple-runner-source.mjs. The host reaches that file through the two
// hooks below, resolved by class name rather than by symbol, so a packaged build's
// app target builds with the fixtures file absent and the unit-test build finds it.
@interface AgentDeviceRunnerViewController ()
@property(nonatomic, strong, readwrite) UILabel *label;
@end

@implementation AgentDeviceRunnerViewController

// The view controller class the scene delegate roots the window at. The fixture host is
// named here rather than referenced: AgentDeviceRunnerAppFixtures.m declares
// AgentDeviceRunnerFixtureViewController only under AGENT_DEVICE_RUNNER_UNIT_TESTS, so
// a rename there must update this lookup.
+ (Class)agentDeviceRootViewControllerClass {
#if TARGET_OS_IOS
  Class const fixtureHost = NSClassFromString(@"AgentDeviceRunnerFixtureViewController");
  if (fixtureHost != Nil) {
    return fixtureHost;
  }
#endif
  return self;
}

// The one extension point between the shipped host and the fixture host: called after
// the window carries its root view controller and before it is shown, so a fixture
// window the override adds stays behind the main window, as before.
- (void)agentDeviceWillAttachToWindow:(UIWindow *)window {
  (void)window;
}

- (void)viewDidLoad {
  [super viewDidLoad];

  self.view.backgroundColor = UIColor.whiteColor;

  UILabel *label = [[UILabel alloc] init];
  label.text = @"Agent Device Runner";
  label.font = [UIFont preferredFontForTextStyle:UIFontTextStyleTitle2];
  label.textAlignment = NSTextAlignmentCenter;
  label.translatesAutoresizingMaskIntoConstraints = NO;

  [self.view addSubview:label];
  [NSLayoutConstraint activateConstraints:@[
    [label.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
    [label.centerYAnchor constraintEqualToAnchor:self.view.centerYAnchor],
  ]];
  self.label = label;
}

@end

// UIApplicationSceneManifest in Info.plist names this class; a rename must update the manifest.
@interface AgentDeviceRunnerSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation AgentDeviceRunnerSceneDelegate

- (void)scene:(UIScene *)scene
    willConnectToSession:(UISceneSession *)session
                 options:(UISceneConnectionOptions *)connectionOptions {
  (void)session;
  (void)connectionOptions;

  if (![scene isKindOfClass:UIWindowScene.class]) {
    return;
  }

  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  AgentDeviceRunnerViewController *const rootViewController =
      [[[AgentDeviceRunnerViewController agentDeviceRootViewControllerClass] alloc] init];
  self.window.rootViewController = rootViewController;
  [rootViewController agentDeviceWillAttachToWindow:self.window];
  [self.window makeKeyAndVisible];
}

@end

@interface AgentDeviceRunnerAppDelegate : UIResponder <UIApplicationDelegate>
@end

@implementation AgentDeviceRunnerAppDelegate
@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass(AgentDeviceRunnerAppDelegate.class));
  }
}

#endif
