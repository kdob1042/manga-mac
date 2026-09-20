"""Allowlisted property operations only. RNA discovery is not execution permission."""
import bpy
import hashlib
import math
from mathutils import Vector
from pathlib import Path
from .observation import object_id

MAX_GLB = 512 * 1024 * 1024


def scalar(value, low, high):
    if type(value) not in (float, int) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError('invalid operation value')
    return value


def import_glb(filename, assets_dir, expected_hash):
    """Import one app-verified Tripo GLB into the currently open GUI.

    The caller supplies only a basename under the app-owned assets directory. The
    hash is checked again in Blender so a stale or replaced artifact cannot be
    imported into a different live scene.
    """
    if not isinstance(filename, str) or not filename or Path(filename).name != filename:
        raise ValueError('asset_path: only an asset filename is allowed')
    if not filename.lower().endswith('.glb'):
        raise ValueError('asset_path: only GLB assets can be imported')
    if not isinstance(expected_hash, str) or len(expected_hash) != 64 \
            or any(ch not in '0123456789abcdef' for ch in expected_hash.lower()):
        raise ValueError('asset_hash: expected SHA-256 is invalid')
    if not isinstance(assets_dir, str) or not assets_dir:
        raise ValueError('asset_path: assets directory is unavailable')
    try:
        configured_root = Path(assets_dir)
        if configured_root.is_symlink():
            raise ValueError('asset_path: assets directory is a symlink')
        root = configured_root.resolve(strict=True)
        raw = root / filename
        if raw.parent != root or raw.is_symlink():
            raise ValueError('asset_path: asset is outside the managed assets directory')
        path = raw.resolve(strict=True)
    except (OSError, RuntimeError):
        raise ValueError('asset_path: asset is unavailable')
    if path.parent != root or not path.is_file() or path.is_symlink():
        raise ValueError('asset_path: asset is outside the managed assets directory')
    size = path.stat().st_size
    if size < 4 or size > MAX_GLB:
        raise ValueError('asset_size: GLB must be between 4 bytes and 512 MiB')
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        if stream.read(4) != b'glTF':
            raise ValueError('asset_format: file is not a GLB')
        stream.seek(0)
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    if digest.hexdigest() != expected_hash.lower():
        raise ValueError('asset_hash: downloaded artifact changed')
    if not hasattr(bpy.ops.import_scene, 'gltf'):
        raise ValueError('operation_unsupported: Blender GLB importer is unavailable')
    before = {object_id(obj) for obj in bpy.data.objects}
    try:
        result = bpy.ops.import_scene.gltf(filepath=str(path))
    except Exception as exc:
        raise ValueError(f'asset_import_failed: {exc}')
    if 'FINISHED' not in result:
        raise ValueError('asset_import_failed: Blender did not finish importing the GLB')
    bpy.context.view_layer.update()
    imported = [obj for obj in bpy.data.objects if object_id(obj) not in before]
    if not imported:
        raise ValueError('asset_import_failed: the GLB did not add an object')
    return {'imported': True, 'file': filename, 'hash': digest.hexdigest(),
            'objects': [{'id': object_id(obj), 'name': obj.name, 'type': obj.type}
                        for obj in imported]}


def apply(op):
    kind = op.get('kind')
    keys = {'camera': {'kind', 'object', 'object_id', 'value'},
            'constraint': {'kind', 'object', 'object_id', 'constraint', 'value'},
            'transform': {'kind', 'object', 'object_id', 'location'},
            'rotation': {'kind', 'object', 'object_id', 'rotation'},
            'aim': {'kind', 'object', 'object_id', 'target'}}
    if kind not in keys or set(op) != keys[kind]:
        raise ValueError('operation_unsupported: unapproved property/operator')
    obj = bpy.context.scene.objects.get(op['object'])
    if not obj or object_id(obj) != op['object_id']:
        raise ValueError('target_unknown: object identity changed')
    if obj.library or obj.animation_data or obj.data and getattr(obj.data, 'animation_data', None):
        raise ValueError('operation_unsupported: linked or animated target')
    if kind == 'camera':
        if obj != bpy.context.scene.camera:
            raise ValueError('target_unknown: not active camera')
        value = scalar(op['value'], 10, 250)
        before = obj.data.lens
        obj.data.lens = value
        actual = obj.data.lens
    elif kind == 'constraint':
        constraint = obj.constraints.get(op['constraint'])
        if constraint is None:
            raise ValueError('target_unknown: no such constraint')
        value = scalar(op['value'], 0, 1)
        before = constraint.influence
        constraint.influence = value
        actual = constraint.influence
    else:
        if obj.parent or obj.constraints or obj.rotation_mode != 'XYZ' or bpy.context.mode != 'OBJECT':
            raise ValueError('operation_unsupported: transform context')
        if kind in ('rotation', 'aim') and obj != bpy.context.scene.camera:
            raise ValueError('target_unknown: not active camera')
        value = op[{'transform': 'location', 'rotation': 'rotation', 'aim': 'target'}[kind]]
        if not isinstance(value, list) or len(value) != 3:
            raise ValueError('invalid location')
        value = [scalar(x, -10000, 10000) for x in value]
        if kind == 'transform':
            before = list(obj.location)
            obj.location = value
            actual = list(obj.location)
        else:
            before = list(obj.rotation_euler)
            if kind == 'aim':
                direction = Vector(value) - obj.location
                if direction.length < 1e-6:
                    raise ValueError('invalid target: camera and target coincide')
                obj.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler('XYZ')
            else:
                obj.rotation_euler = value
            actual = list(obj.rotation_euler)
    bpy.context.view_layer.update()
    # read back actual configured value; visual/evaluated effect remains a separate check
    return {'before': before, 'actual': actual, 'changed': before != actual,
            'object_id': object_id(obj), 'operation': op}
