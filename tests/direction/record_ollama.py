"""CI-only transparent recorder for PUBLIC synthetic prompts; never used by the app."""
from http.server import BaseHTTPRequestHandler, HTTPServer
from http.client import HTTPConnection
from pathlib import Path
import json
import os

root = Path(os.environ['DIRECTION_RESULTS'])
class Recorder(BaseHTTPRequestHandler):
    counter = 0
    def do_POST(self):
        if self.path != '/api/chat':
            self.send_error(404)
            return
        size = int(self.headers.get('Content-Length', '0'))
        if not 0 < size <= 24 * 1024 * 1024:
            self.send_error(413)
            return
        request = self.rfile.read(size)
        Recorder.counter += 1
        path = root / f'wire-{Recorder.counter}.json'
        record = {'request': json.loads(request)}
        path.write_text(json.dumps(record, indent=2))
        connection = HTTPConnection('127.0.0.1', 11435, timeout=600)
        try:
            connection.request('POST', '/api/chat', body=request, headers={'Content-Type':'application/json'})
            response = connection.getresponse()
            body = response.read()
            record.update(status=response.status, response=body.decode())
            path.write_text(json.dumps(record, indent=2))
            self.send_response(response.status)
            self.send_header('Content-Type', response.getheader('Content-Type', 'application/json'))
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        finally:
            connection.close()
HTTPServer(('127.0.0.1',11434), Recorder).serve_forever()
