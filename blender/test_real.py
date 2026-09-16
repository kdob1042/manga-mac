"""Actual Blender subprocess acceptance; pass the verified Blender binary as argv[1]."""
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile

binary = str(Path(sys.argv[1]).resolve(strict=True))
worker = Path(__file__).with_name('worker.py').resolve()
root = Path(sys.argv[2]).resolve()
root.mkdir(parents=True, exist_ok=True)

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def run(script, payload=None):
    result = subprocess.run([binary, '--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', str(script)], input=json.dumps(payload) if payload else '', text=True, capture_output=True, timeout=180)
    with (root / 'blender-test.log').open('a') as log:
        log.write(result.stdout + result.stderr)
    return result

fixture = root / 'fixture.py'
fixture.write_text("import bpy\nfrom pathlib import Path\nscene=bpy.context.scene\nscene.render.engine='CYCLES'\nscene.cycles.samples=4\nscene.camera.data.lens=35\nbpy.ops.wm.save_as_mainfile(filepath=" + repr(str(root / 'fixture.blend')) + ")\n")
assert run(fixture).returncode == 0
source = root / 'fixture.blend'
original = sha(source)

def operation(name, source, operation, valid=True):
    out = root / name
    out.mkdir()
    result = run(worker, {'input': str(source), 'input_hash': sha(source), 'library_root': str(root), 'output_root': str(out), 'operation': operation})
    if not valid:
        assert result.returncode != 0 and not (out / 'result.json').exists()
        return None
    assert result.returncode == 0, result.stderr
    result = json.loads((out / 'result.json').read_text())
    assert result['blender_version'] == [4, 5, 13]
    assert result['checkpoint']['hash'] == sha(out / 'checkpoint.blend')
    return result

initial = operation('inspect', source, {'kind': 'inspect'})
assert initial['state']['lens'] == 35
first = operation('before', source, {'kind': 'capture', 'width': 128, 'height': 128})
changed = operation('camera', source, {'kind': 'camera', 'lens': 70})
assert changed['state']['lens'] == 70
reopened = operation('reopen', root / 'camera/checkpoint.blend', {'kind': 'inspect'})
assert reopened['state']['lens'] == 70
final = operation('after', root / 'camera/checkpoint.blend', {'kind': 'capture', 'width': 128, 'height': 128})
assert first['image']['hash'] != final['image']['hash']
for name in ['before', 'after']:
    png = (root / name / 'capture.png').read_bytes()
    assert png[:8] == b'\x89PNG\r\n\x1a\n'
    assert struct.unpack('>II', png[16:24]) == (128, 128)
assert sha(source) == original
operation('reject-code', source, {'kind': 'python', 'code': 'raise RuntimeError()'}, False)
operation('reject-size', source, {'kind': 'capture', 'width': 0, 'height': 128}, False)
operation('reject-nan', source, {'kind': 'camera', 'lens': float('nan')}, False)
(root / 'acceptance.json').write_text(json.dumps({'STATE-01': 'pass', 'save_reopen': 'pass', 'source_unchanged': True, 'fixed_operations': 'pass', 'version': initial['blender_version'], 'build': initial['blender_build'], 'before': first['image']['hash'], 'after': final['image']['hash'], 'Mac': 'not_run'}))
print('Actual Blender inspection, camera readback, rendering, save/reopen and rejected operations passed')
