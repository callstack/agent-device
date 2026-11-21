#!/usr/bin/env python3
"""
AT-SPI2 accessibility tree dumper.

Traverses the AT-SPI2 accessibility tree and outputs JSON to stdout.
Used by agent-device's Linux platform support as a subprocess.

Requires: python3-gi, gir1.2-atspi-2.0
"""

import json
import sys

import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

MAX_NODES = 1500
MAX_DEPTH = 12
MAX_DESKTOP_APPS = 24

VALID_SURFACES = ("desktop", "frontmost-app")


def get_screen_origin(accessible):
    """The screen-absolute (x, y) of a top-level frame/window's own Component extents.

    Unlike descendant widgets (see get_rect), a top-level's own SCREEN-coordinate extents are
    correct — GTK4's AT-SPI bridge only loses the translation when walking from a widget up
    through its ancestor chain to the root, not for the root itself.
    """
    try:
        component = accessible.get_component_iface()
        if not component:
            return None
        extents = component.get_extents(Atspi.CoordType.SCREEN)
        if not extents:
            return None
        return (extents.x, extents.y)
    except Exception:
        return None


def get_rect(accessible, frame_origin):
    """A node's screen-absolute rect.

    GTK4's AT-SPI bridge returns (0, 0) as the origin of Component.get_extents(SCREEN) for every
    non-toplevel widget — confirmed live (CI run 32503838660): a raw xdotool click at the
    computed center of a digit button's "screen" rect landed on the window's own header-bar
    button instead. CoordType.WINDOW gives correct, distinct per-widget offsets, so the
    screen-absolute rect is that offset plus the enclosing top-level frame's own (correct)
    screen origin.
    """
    try:
        component = accessible.get_component_iface()
        if not component:
            return None
        extents = component.get_extents(Atspi.CoordType.WINDOW)
        if not extents:
            return None
        if extents.width <= 0 or extents.height <= 0:
            return None
        origin_x, origin_y = frame_origin if frame_origin else (0, 0)
        return {
            "x": extents.x + origin_x,
            "y": extents.y + origin_y,
            "width": extents.width,
            "height": extents.height,
        }
    except Exception:
        return None


def get_text_value(accessible):
    """The Text interface's content, if any.

    Must call Atspi.Text.get_text(accessible, ...) as an unbound/static call, NOT
    accessible.get_text_iface().get_text(...) — the bound form resolves to the deprecated
    1-argument Atspi.Accessible.get_text() instead (a documented PyGObject binding collision:
    https://discourse.gnome.org/t/how-can-i-explicitly-call-atspi-text-get-text/36684), raising
    "takes exactly 1 argument (3 given)" for every node, silently swallowed as "no text" by the
    except-Exception below. Confirmed live (CI run 32505154107): the static form correctly
    returns typed text ("155") where the bound form threw on the same node.
    """
    try:
        text_iface = accessible.get_text_iface()
        if not text_iface:
            return None
        count = Atspi.Text.get_character_count(accessible)
        if count <= 0:
            return None
        value = Atspi.Text.get_text(accessible, 0, count)
        return value if value else None
    except Exception:
        return None


def get_numeric_value(accessible):
    try:
        value_iface = accessible.get_value_iface()
        if not value_iface:
            return None
        current = value_iface.get_current_value()
        if current is None:
            return None
        return str(current)
    except Exception:
        return None


def has_state(state_set, state_type):
    try:
        return state_set.contains(state_type)
    except Exception:
        return False


def traverse_node(accessible, depth, parent_index, ctx, app_info, window_title=None, frame_origin=None):
    if len(ctx["nodes"]) >= ctx["max_nodes"] or depth > ctx["max_depth"] or not accessible:
        return

    try:
        role_name = accessible.get_role_name() or "unknown"
    except Exception:
        role_name = "unknown"

    try:
        name = accessible.get_name() or ""
    except Exception:
        name = ""

    try:
        description = accessible.get_description() or ""
    except Exception:
        description = ""

    label = name or description or None

    # Entering a new top-level resets the frame origin used to translate its descendants'
    # WINDOW-relative extents to screen-absolute (see get_rect) — each frame/dialog is a
    # separate X11 top-level with its own screen position.
    is_frame = role_name in ("frame", "window", "dialog")
    effective_frame_origin = (get_screen_origin(accessible) or frame_origin) if is_frame else frame_origin
    rect = get_rect(accessible, effective_frame_origin)

    try:
        state_set = accessible.get_state_set()
    except Exception:
        state_set = None

    enabled = has_state(state_set, Atspi.StateType.ENABLED) if state_set else None
    selected = has_state(state_set, Atspi.StateType.SELECTED) if state_set else None
    visible = has_state(state_set, Atspi.StateType.VISIBLE) if state_set else True
    showing = has_state(state_set, Atspi.StateType.SHOWING) if state_set else True
    hittable = (enabled is not False) and visible and showing and (rect is not None)

    current_window_title = window_title
    if current_window_title is None and is_frame:
        current_window_title = label

    nodes = ctx["nodes"]
    node_index = len(nodes)
    value = get_text_value(accessible) or get_numeric_value(accessible)

    node = {
        "index": node_index,
        "role": role_name,
        "label": label,
        "value": value,
        "rect": rect,
        "enabled": enabled,
        "selected": selected,
        "hittable": hittable,
        "depth": depth,
        "parentIndex": parent_index,
        "pid": app_info.get("pid"),
        "appName": app_info.get("appName"),
        "windowTitle": current_window_title,
    }
    nodes.append(node)

    try:
        child_count = accessible.get_child_count()
    except Exception:
        return

    for i in range(child_count):
        if len(nodes) >= ctx["max_nodes"]:
            break
        try:
            child = accessible.get_child_at_index(i)
            if child:
                traverse_node(
                    child, depth + 1, node_index, ctx, app_info,
                    current_window_title, effective_frame_origin
                )
        except Exception:
            pass


def find_focused_application(desktop, app_count):
    for i in range(app_count):
        try:
            app = desktop.get_child_at_index(i)
            if not app:
                continue
            child_count = app.get_child_count()
            for j in range(child_count):
                try:
                    win = app.get_child_at_index(j)
                    if not win:
                        continue
                    state_set = win.get_state_set()
                    if state_set and has_state(state_set, Atspi.StateType.ACTIVE):
                        return app
                except Exception:
                    pass
        except Exception:
            pass

    # Fallback: first app with children
    for i in range(app_count):
        try:
            app = desktop.get_child_at_index(i)
            if app and app.get_child_count() > 0:
                return app
        except Exception:
            pass
    return None


def get_app_info(app):
    try:
        app_name = app.get_name() or None
    except Exception:
        app_name = None
    try:
        pid = app.get_process_id()
    except Exception:
        pid = None
    return {"appName": app_name, "pid": pid}


def capture(surface, max_nodes=MAX_NODES, max_depth=MAX_DEPTH, max_apps=MAX_DESKTOP_APPS):
    desktop = Atspi.get_desktop(0)
    if not desktop:
        return {"error": "Could not get desktop accessible. Is the accessibility bus running?"}

    app_count = desktop.get_child_count()
    ctx = {"nodes": [], "max_nodes": max_nodes, "max_depth": max_depth}

    if surface == "frontmost-app":
        focused = find_focused_application(desktop, app_count)
        if focused:
            traverse_node(focused, 0, None, ctx, get_app_info(focused))
    else:
        apps_to_traverse = min(app_count, max_apps)
        for i in range(apps_to_traverse):
            if len(ctx["nodes"]) >= max_nodes:
                break
            try:
                app = desktop.get_child_at_index(i)
                if not app or app.get_child_count() == 0:
                    continue
                traverse_node(app, 0, None, ctx, get_app_info(app))
            except Exception:
                pass

    nodes = ctx["nodes"]
    return {
        "nodes": nodes,
        "truncated": len(nodes) >= max_nodes,
        "surface": surface,
    }


def parse_int_arg(value, name):
    try:
        n = int(value)
        if n < 0:
            raise ValueError(f"negative value")
        return n
    except ValueError as e:
        json.dump({"error": f"Invalid value for {name}: '{value}' ({e})"}, sys.stdout)
        sys.exit(1)


def main():
    try:
        surface = "desktop"
        max_nodes = MAX_NODES
        max_depth = MAX_DEPTH
        max_apps = MAX_DESKTOP_APPS

        args = sys.argv[1:]
        i = 0
        while i < len(args):
            if args[i] == "--surface" and i + 1 < len(args):
                surface = args[i + 1]
                i += 2
            elif args[i] == "--max-nodes" and i + 1 < len(args):
                max_nodes = parse_int_arg(args[i + 1], "--max-nodes")
                i += 2
            elif args[i] == "--max-depth" and i + 1 < len(args):
                max_depth = parse_int_arg(args[i + 1], "--max-depth")
                i += 2
            elif args[i] == "--max-apps" and i + 1 < len(args):
                max_apps = parse_int_arg(args[i + 1], "--max-apps")
                i += 2
            else:
                i += 1

        if surface not in VALID_SURFACES:
            json.dump(
                {"error": f"Unknown surface '{surface}'. Valid: {', '.join(VALID_SURFACES)}"},
                sys.stdout,
            )
            sys.exit(1)

        result = capture(surface, max_nodes, max_depth, max_apps)
        json.dump(result, sys.stdout, ensure_ascii=False)
    except SystemExit:
        raise
    except Exception as e:
        json.dump({"error": f"Unexpected error: {e}"}, sys.stdout)
        sys.exit(1)


if __name__ == "__main__":
    main()
