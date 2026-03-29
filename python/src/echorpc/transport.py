"""Transport layer protocols — protocol-agnostic contracts."""

from __future__ import annotations

from typing import Any, Callable, Protocol, runtime_checkable

from python.echorpc.core import DEFAULT_CONNECT_TIMEOUT


@runtime_checkable
class ITransportConnection(Protocol):
    """Single bidirectional message channel (one per connected peer)."""

    async def send(self, raw: str) -> None: ...
    async def close(self) -> None: ...

    @property
    def is_open(self) -> bool: ...

    on_message: Callable[[str], Any] | None
    on_close: Callable[[], Any] | None


@runtime_checkable
class ITransportClient(Protocol):
    """Client-side transport — manages outgoing connection lifecycle."""

    async def connect(self, timeout: float = DEFAULT_CONNECT_TIMEOUT) -> None: ...
    async def disconnect(self) -> None: ...
    async def send(self, raw: str) -> None: ...

    @property
    def connected(self) -> bool: ...

    on_open: Callable[[], Any] | None
    on_close: Callable[[], Any] | None
    on_message: Callable[[str], Any] | None
    on_auth_failed: Callable[[], Any] | None


@runtime_checkable
class ITransportServer(Protocol):
    """Server-side transport — accepts incoming connections."""

    async def start(self) -> None: ...
    async def stop(self) -> None: ...

    @property
    def address(self) -> tuple[str, int] | None: ...

    on_connection: Callable[[ITransportConnection, dict[str, Any]], Any] | None
