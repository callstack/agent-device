#!/usr/bin/env python3

import argparse
import asyncio
import json
import logging
import resource
import sys
import time
from typing import Any

from idb.common.types import (
    AccessibilityBackend,
    AccessibilityInfoOptions,
    AccessibilityOutputFormat,
    DomainSocketAddress,
)
from idb.grpc.client import Client


KEYS = [
    "AXFrame",
    "AXLabel",
    "AXValue",
    "AXUniqueId",
    "AXEnabled",
    "AXSelected",
    "AXFocused",
    "type",
    "role",
    "subrole",
]


def as_record(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def string_value(record: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = record.get(key)
        if isinstance(value, str):
            return value
    return None


def rect_value(record: dict[str, Any]) -> dict[str, float] | None:
    value = as_record(record.get("frame"))
    if value is None:
        value = as_record(record.get("AXFrame"))
    if value is None:
        return None
    if not all(isinstance(value.get(key), (int, float)) for key in ("x", "y", "width", "height")):
        return None
    return {
        "x": float(value["x"]),
        "y": float(value["y"]),
        "width": float(value["width"]),
        "height": float(value["height"]),
    }


def bool_value(record: dict[str, Any], *keys: str) -> bool | None:
    for key in keys:
        value = record.get(key)
        if isinstance(value, bool):
            return value
    return None


def node_from_element(element: dict[str, Any], index: int) -> dict[str, Any]:
    node: dict[str, Any] = {"id": f"n{index}"}
    fields = (
        ("type", string_value(element, "type")),
        ("role", string_value(element, "role")),
        ("subrole", string_value(element, "subrole")),
        ("label", string_value(element, "label", "AXLabel")),
        ("value", string_value(element, "value", "AXValue")),
        ("identifier", string_value(element, "identifier", "AXUniqueId")),
        ("frame", rect_value(element)),
        ("enabled", bool_value(element, "enabled", "AXEnabled")),
        ("selected", bool_value(element, "selected", "AXSelected")),
        ("focused", bool_value(element, "focused", "AXFocused")),
    )
    for key, value in fields:
        if value is not None:
            node[key] = value
    return node


def elements_from_document(document: Any) -> list[dict[str, Any]] | None:
    if not isinstance(document, list):
        return None
    elements: list[dict[str, Any]] = []
    for element in document:
        record = as_record(element)
        if record is not None:
            elements.append(record)
    return elements


def process_ids(elements: list[dict[str, Any]]) -> set[int]:
    return {
        int(element["pid"])
        for element in elements
        if isinstance(element.get("pid"), int) and not isinstance(element.get("pid"), bool)
    }


def expected_pid(generation: str | None) -> int | None:
    if generation is None or not generation.startswith("pid:"):
        return None
    try:
        return int(generation.removeprefix("pid:").split(":", 1)[0])
    except ValueError:
        return None


def dimensions_value(description: Any) -> dict[str, float] | None:
    dimensions = getattr(description, "screen_dimensions", None)
    width = getattr(dimensions, "width_points", None)
    height = getattr(dimensions, "height_points", None)
    if not isinstance(width, (int, float)) or not isinstance(height, (int, float)):
        return None
    if width < 0 or height < 0:
        return None
    return {"x": 0.0, "y": 0.0, "width": float(width), "height": float(height)}


def usage_cpu_ms(usage: resource.struct_rusage) -> float:
    return (usage.ru_utime + usage.ru_stime) * 1000


def usage_memory_bytes(usage: resource.struct_rusage) -> int:
    return int(usage.ru_maxrss)


def failure_response(request: dict[str, Any], kind: str, code: str, duration_ms: float = 0) -> dict[str, Any]:
    return {
        "version": 1,
        "id": request.get("id", "unknown"),
        "candidate": request.get("candidate", "guest-simulator-framework-bridge"),
        "ok": False,
        "failure": {"kind": kind, "code": code},
        "metrics": {
            "requestBytes": 0,
            "responseBytes": 0,
            "nodeCount": 0,
            "maxTraversalDepth": 0,
            "cpuMs": None,
            "memoryBytes": None,
            "durationMs": duration_ms,
        },
    }


def build_response(
    request: dict[str, Any],
    document: Any,
    viewport: dict[str, float] | None,
    duration_ms: float,
    cpu_ms: float,
    memory_bytes: int,
    request_bytes: int,
) -> dict[str, Any]:
    elements = elements_from_document(document)
    if elements is None:
        return failure_response(request, "malformed-tree", "guest-document-shape", duration_ms)
    limits = as_record(request.get("limits")) or {}
    if len(elements) > int(limits.get("maxNodes", 0)):
        return failure_response(request, "malformed-tree", "node-limit-exceeded", duration_ms)
    pids = process_ids(elements)
    expected = request.get("expectedTargetGeneration")
    expected = expected if isinstance(expected, str) else None
    wanted_pid = expected_pid(expected)
    if wanted_pid is not None and pids and wanted_pid not in pids:
        observed = ",".join(f"pid:{pid}" for pid in sorted(pids))
        return {
            **failure_response(request, "stale-generation", "target-generation-mismatch", duration_ms),
            "failure": {
                "kind": "stale-generation",
                "code": "target-generation-mismatch",
                "expectedTargetGeneration": expected,
                "observedTargetGeneration": observed,
            },
            "metrics": {
                "requestBytes": request_bytes,
                "responseBytes": 0,
                "nodeCount": len(elements),
                "maxTraversalDepth": 0,
                "cpuMs": cpu_ms,
                "memoryBytes": memory_bytes,
                "durationMs": duration_ms,
            },
        }
    generation = expected
    if generation is None and len(pids) == 1:
        generation = f"pid:{next(iter(pids))}"
    residue: list[dict[str, Any]] = []
    if viewport is None:
        residue.append({"kind": "missing-viewport", "reason": "not-provided"})
    if generation is None:
        residue.append({"kind": "unavailable-fact", "fact": "generation"})
    nodes = [node_from_element(element, index) for index, element in enumerate(elements)]
    return {
        "version": 1,
        "id": request["id"],
        "candidate": request["candidate"],
        "ok": True,
        "acquisition": {
            "targetId": f"simulator:{request['simulatorUdid']}",
            "targetGeneration": generation,
            "nodes": nodes,
            "viewport": (
                {"kind": "reported", "rect": viewport}
                if viewport is not None
                else {"kind": "missing", "reason": "not-provided"}
            ),
            "truncated": False,
            "residue": residue,
        },
        "metrics": {
            "requestBytes": request_bytes,
            "responseBytes": 0,
            "nodeCount": len(nodes),
            "maxTraversalDepth": 0,
            "cpuMs": cpu_ms,
            "memoryBytes": memory_bytes,
            "durationMs": duration_ms,
        },
    }


async def read_one(
    client: Client,
    request: dict[str, Any],
    viewport: dict[str, float] | None,
    request_bytes: int,
) -> dict[str, Any]:
    started = time.perf_counter()
    cpu_before = resource.getrusage(resource.RUSAGE_SELF)
    try:
        info = await asyncio.wait_for(
            client.accessibility_info(
                target=None,
                options=AccessibilityInfoOptions(
                    keys=KEYS,
                    backend=AccessibilityBackend.AXBRIDGE_PERSISTENT,
                    format=AccessibilityOutputFormat.LEGACY,
                ),
            ),
            timeout=float((as_record(request.get("limits")) or {}).get("maxDurationMs", 5000)) / 1000,
        )
        document = json.loads(info.json)
        response = build_response(
            request,
            document,
            viewport,
            (time.perf_counter() - started) * 1000,
            usage_cpu_ms(resource.getrusage(resource.RUSAGE_SELF)) - usage_cpu_ms(cpu_before),
            usage_memory_bytes(resource.getrusage(resource.RUSAGE_SELF)),
            request_bytes,
        )
    except asyncio.TimeoutError:
        response = failure_response(
            request,
            "timeout",
            "guest-read-timeout",
            (time.perf_counter() - started) * 1000,
        )
    except json.JSONDecodeError:
        response = failure_response(
            request,
            "malformed-tree",
            "guest-document-json",
            (time.perf_counter() - started) * 1000,
        )
    except Exception:
        response = failure_response(
            request,
            "transport-failure",
            "guest-accessibility-rpc",
            (time.perf_counter() - started) * 1000,
        )
    encoded = json.dumps(response, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    response["metrics"]["responseBytes"] = len(encoded)
    return response


async def serve(socket_path: str) -> None:
    logger = logging.getLogger("agent-device-guest-reader")
    logger.addHandler(logging.NullHandler())
    async with Client.build(
        DomainSocketAddress(path=socket_path),
        logger,
        exchange_metadata=False,
    ) as client:
        viewport = None
        try:
            viewport = dimensions_value(await client.describe())
        except Exception:
            viewport = None
        while True:
            line = await asyncio.to_thread(sys.stdin.buffer.readline)
            if not line:
                return
            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(request, dict) or not isinstance(request.get("id"), str):
                continue
            response = await read_one(client, request, viewport, len(line))
            sys.stdout.write(json.dumps(response, separators=(",", ":"), ensure_ascii=False) + "\n")
            sys.stdout.flush()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    args = parser.parse_args()
    try:
        asyncio.run(serve(args.socket))
    except Exception as error:
        sys.stderr.write(f"guest reader stopped: {error}\n")
        raise


if __name__ == "__main__":
    main()
