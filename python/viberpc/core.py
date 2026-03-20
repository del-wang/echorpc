"""JSON-RPC 2.0 core types and utilities."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any


# ── Error codes ──────────────────────────────────────────────────────────────

class ErrorCode(IntEnum):
    PARSE_ERROR = -32700
    INVALID_REQUEST = -32600
    METHOD_NOT_FOUND = -32601
    INVALID_PARAMS = -32602
    INTERNAL_ERROR = -32603
    # Custom codes
    NOT_CONNECTED = -1
    TIMEOUT = -2
    AUTH_FAILED = -3


class RpcError(Exception):
    """Structured JSON-RPC error."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        self.code = code
        self.message = message
        self.data = data
        super().__init__(message)

    def to_dict(self) -> dict:
        d: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.data is not None:
            d["data"] = self.data
        return d


# ── Message helpers ──────────────────────────────────────────────────────────

def make_request(method: str, params: Any = None, req_id: str | None = None) -> dict:
    msg: dict[str, Any] = {"jsonrpc": "2.0", "id": req_id or uuid.uuid4().hex[:8], "method": method}
    if params is not None:
        msg["params"] = params
    return msg


def make_response(req_id: str | int, result: Any) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def make_error_response(req_id: str | int | None, error: RpcError) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "error": error.to_dict()}


def make_event(event: str, data: Any = None) -> dict:
    msg: dict[str, Any] = {"jsonrpc": "2.0", "method": f"event:{event}"}
    if data is not None:
        msg["params"] = data
    return msg


# ── Constants ────────────────────────────────────────────────────────────────

DEFAULT_TIMEOUT = 30.0
DEFAULT_PING_INTERVAL = 30.0
DEFAULT_MAX_RECONNECT_DELAY = 5.0
INITIAL_RECONNECT_DELAY = 0.1
PONG_TIMEOUT = 5.0
