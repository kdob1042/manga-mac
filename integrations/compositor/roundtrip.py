"""Real external app acceptance fixture; stdlib only, no inference or image runtime."""
import base64
import json
import os
import pathlib
import secrets
import struct
import subprocess
import sys
import tempfile
import time
import uuid
import zlib


def png(width, height, pixel):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    raw = b''.join(b'\0' + b''.join(bytes(pixel(x, y)) for x in range(width)) for y in range(height))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def main(app):
    with tempfile.TemporaryDirectory(prefix='manga-compositor-') as temp:
        root = pathlib.Path(temp).resolve()
        root.chmod(0o700)
        sid, token = str(uuid.uuid4()), secrets.token_hex(32)
        (root / 'connection.json').write_text(json.dumps({'session': sid, 'token': token}))
        package = root / 'working.comp'
        (package / 'images').mkdir(parents=True)
        ids = [str(uuid.uuid4()).upper() for _ in range(2)]
        images = [png(32, 32, lambda x, y: (0, 0, 255, 255)),
                  png(32, 32, lambda x, y: (255, 0, 0, 255 if 8 <= x < 24 and 8 <= y < 24 else 0))]
        layers = []
        for i, (lid, data) in enumerate(zip(ids, images)):
            (package / 'images' / (lid + '.png')).write_bytes(data)
            layers.append({'id': lid, 'name': ['Background', 'Person'][i], 'isVisible': True,
                           'transform': {'origin': [0, 0], 'size': [32, 32], 'rotation': 0, 'flipX': False, 'flipY': False, 'sampling': 'High quality'},
                           'imageFile': lid + '.png'})
        manifest = {'format': 'com.compositor.project', 'version': 8, 'colorSpace': 'sRGB',
                    'documentID': str(uuid.uuid4()).upper(), 'width': 32, 'height': 32,
                    'activeLayerID': ids[-1], 'layers': layers}
        (package / 'manifest.json').write_text(json.dumps(manifest))
        process = subprocess.Popen([str(pathlib.Path(app) / 'Contents/MacOS/Compositor'), '--manga-session', str(root)])
        try:
            def request(op, state=None, **args):
                rid = str(uuid.uuid4())
                body = {'id': rid, 'protocol': 1, 'session': sid, 'token': token, 'op': op, **args}
                if state:
                    body.update(document=state['document'], revision=state['revision'])
                pending = root / 'request.tmp'
                pending.write_text(json.dumps(body)); pending.replace(root / 'request.json')
                result = root / (rid + '.json')
                until = time.monotonic() + 40
                while not result.exists():
                    if time.monotonic() > until or process.poll() is not None:
                        raise AssertionError(f'No response for {op}; exit={process.poll()}')
                    time.sleep(0.1)
                return json.loads(result.read_text())

            state = request('open')['value']
            assert state['owner'] == 'app' and len(state['layers']) == 2
            baseline = request('snapshot', state)['value']
            state = request('claim', request('state')['value'])['value']
            changed = request('transform', state, layer=ids[1], x=4, y=0, width=32, height=32, rotation=0, visible=True)
            assert changed['ok']
            assert not request('transform', state, layer=ids[1], x=5, y=0, width=32, height=32, rotation=0, visible=True)['ok']
            state = changed['value']
            human = request('handoff', state)['value']
            assert human['owner'] == 'human'
            assert not request('snapshot', human)['ok']
            state = request('claim', human)['value']
            saved = request('snapshot', state)['value']
            assert saved['bundle']['images'] == baseline['bundle']['images'], 'Placement must not change source pixels'
            assert saved['image'] != baseline['image'], 'Actual renderer must reflect placement'
            assert saved['bundle']['manifest']['layers'][0] == baseline['bundle']['manifest']['layers'][0]
            # Repeat exact ID by leaving request.json in place: response and revision must be unchanged.
            time.sleep(0.5)
            assert request('state')['value']['revision'] == state['revision']
            output = pathlib.Path(os.environ.get('COMPOSITOR_TEST_OUTPUT', temp))
            output.mkdir(parents=True, exist_ok=True)
            (output / 'compositor-roundtrip.json').write_text(json.dumps({'status': 'passed', 'upstream': 'c39da13b5db11bc8678ec04a7a748e1e0a589244', 'inference': 'not_run'}))
            (output / 'composite.png').write_bytes(base64.b64decode(saved['image'].split(',')[1]))
        finally:
            # Only the exact fixture process is terminated, never another user's editor.
            process.terminate()
            process.wait(timeout=10)


if __name__ == '__main__':
    main(sys.argv[1])
