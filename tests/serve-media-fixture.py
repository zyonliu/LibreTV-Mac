#!/usr/bin/env python3
"""Create a short, genuine HLS fixture from Apple's published streaming example.
Not part of the application. Only binds loopback and serves files under build/verification-media.
"""
import functools
import http.server
import pathlib
import urllib.parse
import urllib.request
import time

ROOT = pathlib.Path(__file__).resolve().parents[1] / 'build' / 'verification-media'
BASE = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/'
ROOT.mkdir(parents=True, exist_ok=True)

def read(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read()

if not (ROOT / 'sample.m3u8').exists():
    master = read(BASE + 'master.m3u8').decode()
    variants = [line.strip() for line in master.splitlines() if line.strip() and not line.startswith('#')]
    playlist_url = urllib.parse.urljoin(BASE + 'master.m3u8', variants[0])
    playlist = read(playlist_url).decode()
    output = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD']
    count = 0
    duration = '#EXTINF:6.0,'
    for line in playlist.splitlines():
        if line.startswith('#EXTINF:'):
            duration = line
        elif line.strip() and not line.startswith('#'):
            segment = read(urllib.parse.urljoin(playlist_url, line.strip()))
            name = f'segment-{count}.ts'
            (ROOT / name).write_bytes(segment)
            output.extend([duration, name])
            count += 1
            if count == 3:
                break
    output.append('#EXT-X-ENDLIST')
    (ROOT / 'sample.m3u8').write_text('\n'.join(output) + '\n')
    (ROOT / 'SOURCE.txt').write_text('Apple HLS testing example: https://developer.apple.com/streaming/examples/\n' + playlist_url + '\n')

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        delay = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get('delay', ['0'])[0]
        time.sleep(min(2, max(0, float(delay))))
        super().do_GET()
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()
    def log_message(self, fmt, *args):
        print(fmt % args, flush=True)

print('Playback fixture: http://127.0.0.1:17995/sample.m3u8', flush=True)
http.server.ThreadingHTTPServer(('127.0.0.1', 17995), functools.partial(Handler, directory=str(ROOT))).serve_forever()
