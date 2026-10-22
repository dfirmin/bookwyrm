"""Calls connect over 127.0.0.1, so a VPN or firewall can't get in the way.

The app and this service are always on the same computer, but WebRTC doesn't know that. aioice
(the ICE library under aiortc) offers only the machine's network addresses, deliberately leaving
out 127.0.0.1, and Chromium does the same unless told otherwise. On a laptop with a company VPN or
a strict firewall, UDP between those network addresses is often dropped. The call then "picks up"
but no audio flows either way, until it times out ("Timeout establishing the connection").

So 127.0.0.1 is offered first here, and the app starts Chromium with
--allow-loopback-in-peer-connection (app/main.js). ICE then pairs the two loopback candidates,
which never leave the machine. The network addresses are still offered after it, so nothing that
works today stops working.
"""

from __future__ import annotations

import aioice.ice

LOOPBACK = "127.0.0.1"
_original = aioice.ice.get_host_addresses


def _with_loopback(use_ipv4: bool, use_ipv6: bool) -> list[str]:
    addresses = _original(use_ipv4, use_ipv6)
    if use_ipv4 and LOOPBACK not in addresses:
        addresses = [LOOPBACK, *addresses]
    return addresses


def allow_loopback() -> None:
    """Offer 127.0.0.1 as an ICE host candidate (idempotent)."""
    aioice.ice.get_host_addresses = _with_loopback
