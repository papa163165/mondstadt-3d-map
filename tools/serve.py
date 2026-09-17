#!/usr/bin/env python3
"""本地预览用的静态服务器。

比 `python -m http.server` 多两件事：

1. 返回 `Access-Control-Allow-Origin: *`。
   悬浮窗外层需要把 `index.html` 取回来（CDN 会把 .html 按 text/plain 下发，
   不能直接当 iframe 的地址），没有这个响应头浏览器会以跨域为由拦下。
2. 关掉缓存，改完刷新就能看到。

用法（默认服务仓库根目录）::

    python tools/serve.py --port 8900
    # 然后浏览器打开 http://127.0.0.1:8900/index.html 看地图本身
    # 或者在测试宿主页里把 window.MDSK_MAP_BASE 指到 http://127.0.0.1:8900/
"""

import argparse
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Expose-Headers', '*')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8900)
    ap.add_argument('--bind', default='127.0.0.1')
    ap.add_argument('--dir', default=ROOT)
    args = ap.parse_args()

    handler = functools.partial(Handler, directory=args.dir)
    with http.server.ThreadingHTTPServer((args.bind, args.port), handler) as httpd:
        print('serving %s at http://%s:%d/  (CORS: *)' % (args.dir, args.bind, args.port))
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
