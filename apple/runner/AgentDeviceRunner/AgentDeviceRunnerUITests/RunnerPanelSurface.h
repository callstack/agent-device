// RunnerPanelSurface.h — the one rule that names the window a command books its surface against.
//
// Four runner paths need "the window the screen is": the interaction anchor and reference frame, the
// snapshot viewport, the display a capture names, and the display a synthesized event record routes
// to. Each used to take the application's first window. On a foldable home screen that is
// SpringBoard's status-bar window — a 223x317 box on a panel that may be dark — so taps, the
// snapshot viewport, and captures all landed on a screen nobody was looking at. They resolve through
// this rule instead.
//
// Only this file declares which window wins. The reads that feed it stay with their owners: the
// XCTest bridge reads an application's windows and their display identity, and hands the facts here,
// so a device the rule cannot settle is refused the same way by every caller.

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

NS_ASSUME_NONNULL_BEGIN

// The panel the host reports as lit, in the units the panel table reports it: which display is
// powered, and that panel's own native box in points. The runner cannot read a hinge, and geometry
// cannot say which of two panels is powered, so only the host can name this (ADR 0025): it reads the
// panel table for the request and sends the answer with it. A request that carried no panel leaves
// `displayID` 0.
//
// The size is the panel's *native* box, not the box an app shows on it. The system presents the inner
// panel turned, so its interaction space swaps the side lengths (ADR 0025), which is why the rule
// compares a box either way up.
typedef struct {
  NSUInteger displayID;
  CGFloat widthPt;
  CGFloat heightPt;
} RunnerLitPanel;

// Whether a request named a panel at all. Only a real display identity counts: a panel with no
// display cannot be compared against a window, so it reads as no panel.
static inline BOOL RunnerLitPanelIsNamed(RunnerLitPanel panel) {
  return panel.displayID != 0;
}

// One window the runner measured: the display it is shown on, and the box it occupies in the app's
// coordinate space.
typedef struct {
  NSUInteger displayID;
  CGRect frame;
} RunnerPanelWindowFact;

// What the rule made of an application's windows. Every outcome but `NoWindow` names the window it
// chose or the first one it looked at, through `selected`, so a refusal can report the frame it
// refused instead of returning a silent nil.
typedef NS_ENUM(NSUInteger, RunnerPanelSurfaceSelection) {
  // A window on the lit display whose box is that panel's box, either way up: the screen to book.
  RunnerPanelSurfaceSelectionLitPanelWindow,
  // Windows exist on the lit display but none carries the panel's box, so the app occupies part of
  // it (Split View, a stage, a sheet). The largest is the surface to book: being on the lit panel is
  // the fact a first-window walk could never establish.
  RunnerPanelSurfaceSelectionLitDisplayWindow,
  // Every window the application reported is on a display the host reports as dark.
  RunnerPanelSurfaceSelectionOffLitPanel,
  // No window answered a usable frame, so there is no surface to book right now.
  RunnerPanelSurfaceSelectionNoWindow,
};

// How many windows one walk reads. A device presenting more qualifying windows than this is not a
// surface this rule can settle, and reading past the cap would only widen the risk of reading a
// window that has already vanished (#2995).
#define AGENT_DEVICE_MAX_PANEL_SURFACE_WINDOWS 8

// Half a point: the rounding tolerance the full-screen proof already uses. Sub-pixel layout is not a
// different panel.
#define AGENT_DEVICE_PANEL_SURFACE_TOLERANCE 0.5

// Whether `frame` is the lit panel's surface: anchored at the origin, and the panel's size either way
// up. A frame that is not a measurement at all never qualifies.
FOUNDATION_EXPORT BOOL RunnerPanelFrameIsLitPanelSurface(
  CGRect frame,
  RunnerLitPanel litPanel
);

// Decides which of `windows` a command books against, from the facts alone: no queries, no device
// state, no clock. `litPanel` must name a display: a caller whose request carried no panel has
// nothing to compare a window against and keeps its historic first-window route instead of calling
// this. `count` is capped by the caller at `AGENT_DEVICE_MAX_PANEL_SURFACE_WINDOWS`.
//
// `selected` reports the window the decision was made from and `selectedIndex` its slot in `windows`,
// so a caller keeps the window element it measured instead of reading it again. On a refusal
// `selected` is the first window it looked at, or a null frame when there were none, so the caller's
// refusal names what it saw.
FOUNDATION_EXPORT RunnerPanelSurfaceSelection RunnerPanelSurfaceSelectWindow(
  const RunnerPanelWindowFact *windows,
  NSUInteger count,
  RunnerLitPanel litPanel,
  RunnerPanelWindowFact *selected,
  NSUInteger *selectedIndex
);

NS_ASSUME_NONNULL_END
