"""
run_server.py — hardened launcher for the GATI API.

Plain `uvicorn api:app` fails under a restricted sandbox: uvicorn imports its
event loop, HTTP protocol and lifespan modules *lazily*, after the server starts.
By then the process's implicit cwd entry on sys.path can be unreadable, and every
fresh import dies in importlib's path-finder cache with
`PermissionError: [Errno 1] Operation not permitted`.

Fix: pin sys.path to absolute, verified-readable directories and pre-import
everything uvicorn would otherwise reach for later, while imports still work.

    python3 run_server.py [port]
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)

# Drop the implicit '' (cwd) entry and any path we cannot actually read, so
# importlib never builds a finder for an inaccessible directory.
_clean = [HERE]
for _p in sys.path:
    if not _p:
        continue
    try:
        if os.path.isdir(_p) and _p not in _clean:
            os.listdir(_p)
            _clean.append(_p)
    except OSError:
        pass
sys.path[:] = _clean

# ── pre-import uvicorn's lazily-loaded internals ──
import asyncio                                    # noqa: E402
import h11                                        # noqa: E402
import uvicorn                                    # noqa: E402
from uvicorn.protocols.http import h11_impl       # noqa: E402,F401
from uvicorn.lifespan.on import LifespanOn        # noqa: E402,F401

for _mod in ("uvicorn.protocols.websockets.wsproto_impl",
             "uvicorn.protocols.websockets.websockets_impl"):
    try:
        __import__(_mod)
    except ImportError:
        pass                                       # optional ws backends

import api                                         # noqa: E402

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    # Loopback by default: the Node gateway on :5050 proxies this engine
    # server-side, so nothing outside the Mac needs to reach :8000 for the live
    # map (including the iOS app) to work. The consequence is that /dashboard and
    # /admin are Mac-only — set GATI_MODEL_HOST=0.0.0.0 to open them to the LAN
    # for on-device viewing, understanding that this exposes the model API to
    # everything on that network.
    host = os.environ.get("GATI_MODEL_HOST", "127.0.0.1")
    shown = "localhost" if host in ("127.0.0.1", "0.0.0.0", "::") else host
    print(f"GATI API — serving api:app on http://{shown}:{port}  (bind {host})")
    print(f"  interactive docs : http://{shown}:{port}/docs")
    print(f"  reference train  : http://{shown}:{port}/eta/22229")
    uvicorn.run(
        api.app,
        host=host,
        port=port,
        loop="asyncio",
        http="h11",
        ws="none",
        lifespan="on",
        log_level="info",
    )
