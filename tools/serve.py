"""Local dev server for the web game that never lets the browser cache files,
so an edit shows up on a plain refresh.

    python tools/serve.py            -> http://127.0.0.1:8080/
    python tools/serve.py 8090       -> another port
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


class NoCache(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript",
                      ".webp": "image/webp", ".json": "application/json"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    server = ThreadingHTTPServer(("127.0.0.1", port), partial(NoCache, directory=str(REPO)))
    print(f"Superfans: http://127.0.0.1:{port}/  (Ctrl+C to stop)", flush=True)
    server.serve_forever()
