#!/usr/bin/env python3
"""Local static server that does not cache JS/CSS/JSON."""

from __future__ import annotations

import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()


def main() -> None:
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    port = int(os.environ.get("PORT", "8080"))
    ThreadingHTTPServer(("0.0.0.0", port), NoCacheHandler).serve_forever()


if __name__ == "__main__":
    main()
