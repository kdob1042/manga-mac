"""Actual Blender subprocess acceptance; pass the verified Blender binary as argv[1]."""
import hashlib
import json
import os
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
    env = {**os.environ, 'MANGA_BLENDER_TEST_DIAGNOSTICS': '1'}
    result = subprocess.run([binary, '--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', str(script)], input=json.dumps(payload) if payload else '', text=True, capture_output=True, timeout=180, env=env)
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

# Stage D: independent checkpoints, Blender-owned asset metadata, and external texture pinning.
fixture_d = root / 'fixture-d.py'
fixture_d.write_text("import bpy\nscene=bpy.context.scene\nscene.render.engine='CYCLES'\nscene.cycles.samples=1\nbpy.data.objects['Cube'].asset_mark()\nbpy.data.objects['Cube'].asset_data.description='Reusable test actor'\nimage=bpy.data.images.new('External', width=8, height=8)\nimage.filepath_raw=" + repr(str(root / 'texture.png')) + "\nimage.file_format='PNG'\nimage.save()\nimage.source='FILE'\nimage.use_fake_user=True\nbpy.ops.wm.save_as_mainfile(filepath=" + repr(str(root / 'stage-d.blend')) + ")\n")
assert run(fixture_d).returncode == 0
source_d = root / 'stage-d.blend'
fixed = operation('pinned', source_d, {'kind': 'inspect'})
assert fixed['dependencies_pinned'] and fixed['dependencies'] == []
assert any(asset['name'] == 'Cube' for asset in fixed['assets'])
pinned = root / 'pinned/checkpoint.blend'
(root / 'texture.png').unlink()
# Old version must still open when its original texture has disappeared.
old = operation('old-reopen', pinned, {'kind': 'inspect'})
assert old['dependencies_pinned']
shots = []
for i in range(4):
    result = operation('shot-' + str(i), pinned, {'kind': 'shot', 'scene': fixed['state']['scene'], 'camera': fixed['state']['camera'], 'frame': i + 1})
    shots.append((root / ('shot-' + str(i)) / 'checkpoint.blend', result))
hashes_before = [sha(path) for path, _ in shots]
operation('shot-1-change', shots[1][0], {'kind': 'camera', 'lens': 90})
assert hashes_before == [sha(path) for path, _ in shots]
for i in [0, 2, 3]:
    result = operation('verify-shot-' + str(i), shots[i][0], {'kind': 'inspect'})
    assert result['state'] == shots[i][1]['state']
(root / 'acceptance-d.json').write_text(json.dumps({'SCOPE-01': 'pass', 'VERSION-01-local-texture': 'pass', 'asset_metadata': 'pass', 'linked_nested_libraries': 'not_run', 'Mac': 'not_run'}))

# REUSE-01: query native Asset Library again, import exact source hash, reject stale ref.
catalog = operation('catalog', source, {'kind': 'catalog'})
asset = next(a for a in catalog['library_assets'] if a['file'] == 'stage-d.blend' and a['name'] == 'Cube' and a['kind'] == 'OBJECT')
# Restore texture only for the mutable source library import; the earlier fixed pack required none.
assert run(fixture_d).returncode == 0
catalog = operation('catalog-refresh', source, {'kind': 'catalog'})
asset = next(a for a in catalog['library_assets'] if a['file'] == 'stage-d.blend' and a['name'] == 'Cube' and a['kind'] == 'OBJECT')
imported = operation('asset-import', source, {'kind': 'import', 'file': asset['file'], 'hash': asset['hash'], 'asset_type': asset['kind'], 'name': asset['name']})
assert imported['imported_asset']['hash'] == asset['hash']
assert imported['dependencies_pinned']
operation('reject-stale-asset', source, {'kind': 'import', 'file': asset['file'], 'hash': '0' * 64, 'asset_type': asset['kind'], 'name': asset['name']}, False)
operation('reject-asset-escape', source, {'kind': 'import', 'file': '../escape.blend', 'hash': asset['hash'], 'asset_type': asset['kind'], 'name': asset['name']}, False)

# D-POSE: native Pose API, two actors sharing Armature data, four panels and a video shot.
pose_source = root / 'pose-source.blend'
pose_fixture = Path(__file__).with_name('fixture_pose.py').resolve()
pose_setup = subprocess.run([binary, '--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', str(pose_fixture), '--', str(pose_source)], capture_output=True, text=True, timeout=180)
with (root / 'blender-test.log').open('a') as log:
    log.write(pose_setup.stdout + pose_setup.stderr)
assert pose_setup.returncode == 0, pose_setup.stderr
pose_original = sha(pose_source)
pose_shots = []
for i in range(5):
    name = 'pose-shot-' + str(i)
    operation(name, pose_source, {'kind': 'inspect'})
    pose_shots.append(root / name / 'checkpoint.blend')
pose_hashes = [sha(path) for path in pose_shots]
posed = operation('apply-pose', pose_shots[1], {'kind': 'pose', 'rig': 'PoseActorA', 'action': 'LeanPose', 'frame': 1})
assert posed['applied_pose'] == {'rig': 'PoseActorA', 'action': 'LeanPose', 'frame': 1}
assert pose_hashes == [sha(path) for path in pose_shots]
assert sha(pose_source) == pose_original
# Inspect the actual saved files, not just bridge metadata.
inspect_pose = root / 'inspect-pose.py'
inspect_pose.write_text("import bpy\n" + "\n".join(
    "bpy.ops.wm.open_mainfile(filepath=" + repr(str(path)) + ", load_ui=False, use_scripts=False)\n"
    "a=bpy.data.objects['PoseActorA']; b=bpy.data.objects['PoseActorB']\n"
    "assert abs(a.pose.bones[0].location.x - " + str(expected) + ") < 1e-6\n"
    "assert abs(b.pose.bones[0].location.x - 0.75) < 1e-6\n"
    "assert a.animation_data is None\n"
    "assert b.animation_data.action.name == 'LeanPose'\n"
    "assert abs(b.animation_data.action.layers[0].strips[0].channelbag(b.animation_data.action.slots[0]).fcurves[0].keyframe_points[0].co.y - 0.75) < 1e-6\n"
    for path, expected in [(root / 'apply-pose/checkpoint.blend', 0.75), *[(p, 0) for p in pose_shots]]))
assert run(inspect_pose).returncode == 0
operation('reject-animated-pose', pose_source, {'kind': 'pose', 'rig': 'PoseActorB', 'action': 'LeanPose', 'frame': 1}, False)
operation('reject-missing-pose', pose_source, {'kind': 'pose', 'rig': 'PoseActorA', 'action': 'Missing', 'frame': 1}, False)
operation('reject-nonrig-pose', pose_source, {'kind': 'pose', 'rig': 'Cube', 'action': 'LeanPose', 'frame': 1}, False)
operation('reject-pose-frame', pose_source, {'kind': 'pose', 'rig': 'PoseActorA', 'action': 'LeanPose', 'frame': True}, False)
(root / 'acceptance-pose.json').write_text(json.dumps({'D-POSE-static-local': 'pass', 'four_panels_and_video_isolated': 'pass', 'shared_armature_other_actor_preserved': 'pass', 'action_asset_preserved': 'pass', 'saved_pose_reopened': 'pass', 'animated_target_rejected': 'pass', 'Mac': 'not_run'}))
print('Actual Blender pose application, isolation, reopen and rejection checks passed')
