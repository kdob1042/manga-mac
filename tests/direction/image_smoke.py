"""One bounded real inference using the production Mac helper and a real CI capture."""
import base64
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import time

root = Path('image-results')
root.mkdir(exist_ok=True)
helper = str(Path('helper/.build/release/manga-engine').resolve())
report = {'status': 'running', 'model': 'flux_2_klein_4b_q8p.ckpt', 'resolution': [256, 256],
          'production_character_quality': 'not_run', 'mac_gui': 'not_run', '24gb_performance': 'not_run'}
started = time.time()
try:
    capability = json.loads(Path('capability-results/mac-metal.json').read_text())
    report['capability'] = capability
    if not capability['metal_available']:
        raise RuntimeError('No Metal device on this runner')
    source_path = Path('direction-results/panel-0.png')
    if not source_path.exists():
        source_path = Path('direction-results/baseline-capture.png')
    report['capture_origin'] = source_path.name
    report['production_e2e'] = 'not_run'
    source = source_path.read_bytes()
    report['capture_sha256'] = hashlib.sha256(source).hexdigest()
    with (root / 'prepare.log').open('w') as log:
        subprocess.run([helper, '--prepare'], stdout=log, stderr=subprocess.STDOUT, timeout=600, check=True)
    payload = {'prompt': 'Black and white manga line drawing of this cube on a stage. Preserve the cube position and camera perspective. Clean ink outlines, white background, no text.',
               'references': [], 'original': 'data:image/png;base64,' + base64.b64encode(source).decode(),
               'seed': 42, 'width': 256, 'height': 256}
    request_hash = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    payload['output'] = {'directory': str(root.resolve()), 'request_hash': request_hash}
    (root / 'request.json').write_text(json.dumps(payload))
    with (root / 'generation.log').open('w') as log:
        subprocess.run([helper], input=json.dumps(payload), text=True, stdout=log, stderr=subprocess.STDOUT, timeout=600, check=True)
    image = (root / 'result.png').read_bytes()
    assert image[:8] == b'\x89PNG\r\n\x1a\n'
    assert struct.unpack('>II', image[16:24]) == (256, 256)
    receipt = json.loads((root / 'receipt.json').read_text())
    assert receipt['request_hash'] == request_hash
    assert receipt['hash'] == hashlib.sha256(image).hexdigest()
    report.update(status='pass', image_sha256=receipt['hash'])
except Exception as error:
    report.update(status='fail', error=str(error))
finally:
    report['elapsed_seconds'] = round(time.time() - started, 2)
    (root / 'acceptance.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
if report['status'] != 'pass':
    raise SystemExit(1)
