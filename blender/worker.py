"""Fixed Blender API bridge; no model-generated Python is accepted.

Started by Manga Mac with --background --factory-startup --disable-autoexec.
stdin contains one typed JSON request; stdout is never used as a code channel.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import sys

import bpy


def checksum(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def within(path, roots):
    path = Path(path).resolve(strict=True)
    if not any(path.is_relative_to(root) for root in roots):
        raise ValueError('Path is outside authorized folders')
    return path


def dependencies(roots):
    paths = set()
    for library in bpy.data.libraries:
        if library.packed_file:
            continue
        paths.add(within(bpy.path.abspath(library.filepath), roots))
    for image in bpy.data.images:
        if image.source == 'FILE' and not image.packed_file and image.filepath:
            paths.add(within(bpy.path.abspath(image.filepath, library=image.library), roots))
    for font in bpy.data.fonts:
        if font.filepath and font.filepath != '<builtin>' and not font.packed_file:
            paths.add(within(bpy.path.abspath(font.filepath, library=font.library), roots))
    # Fail closed for dependency forms that this initial bridge cannot pin.
    if any(image.source in {'MOVIE', 'SEQUENCE', 'TILED'} for image in bpy.data.images):
        raise ValueError('Animated or tiled textures need a supported capture adapter')
    if bpy.data.movieclips or bpy.data.sounds or bpy.data.cache_files or bpy.data.volumes:
        raise ValueError('External media dependencies are not supported by this bridge')
    if any(mod.type in {'FLUID', 'CLOTH', 'SOFT_BODY', 'PARTICLE_SYSTEM', 'MESH_CACHE', 'MESH_SEQUENCE_CACHE', 'NODES'} for obj in bpy.data.objects for mod in obj.modifiers):
        raise ValueError('Simulation, geometry-node and external caches are not supported by this capture adapter')
    return [{'path': str(path), 'hash': checksum(path)} for path in sorted(paths)]


def camera_state(scene):
    camera = scene.camera
    if camera is None or camera.type != 'CAMERA':
        raise ValueError('The selected scene has no camera')
    return {
        'scene': scene.name, 'camera': camera.name, 'frame': scene.frame_current,
        'location': list(camera.location), 'rotation_euler': list(camera.rotation_euler),
        'lens': camera.data.lens, 'camera_type': camera.data.type,
        'engine': scene.render.engine,
        'resolution': [scene.render.resolution_x, scene.render.resolution_y],
        'resolution_percentage': scene.render.resolution_percentage,
        'view_transform': scene.view_settings.view_transform,
        'look': scene.view_settings.look, 'exposure': scene.view_settings.exposure,
        'gamma': scene.view_settings.gamma,
        'pixel_aspect': [scene.render.pixel_aspect_x, scene.render.pixel_aspect_y],
        'transparent': scene.render.film_transparent,
        'seed': scene.cycles.seed if scene.render.engine == 'CYCLES' else None,
        'samples': scene.cycles.samples if scene.render.engine == 'CYCLES' else None,
        'matrix_world': [list(row) for row in camera.matrix_world],
        'clip': [camera.data.clip_start, camera.data.clip_end],
        'shift': [camera.data.shift_x, camera.data.shift_y],
        'ortho_scale': camera.data.ortho_scale,
    }


def asset_state():
    # Read Blender-owned names/catalog IDs. This is a replaceable view, not an asset database.
    result = []
    for kind, blocks in [('OBJECT', bpy.data.objects), ('COLLECTION', bpy.data.collections), ('ACTION', bpy.data.actions)]:
        for block in blocks:
            if block.asset_data:
                result.append({'kind': kind, 'name': block.name,
                    'library': block.library.filepath if block.library else None,
                    'catalog_id': block.asset_data.catalog_id,
                    'description': block.asset_data.description,
                    'tags': [tag.name for tag in block.asset_data.tags]})
    return result


def library_assets(library):
    entries = []
    files = sorted(library.rglob('*.blend'))
    if len(files) > 256:
        raise ValueError('Select an asset folder with at most 256 blend files')
    current = Path(bpy.data.filepath).resolve(strict=True)
    for file in files:
        path = within(file, [library])
        # Blender refuses to open its current file as an external asset library.
        if path == current:
            continue
        version = checksum(path)
        with bpy.data.libraries.load(str(path), assets_only=True) as (source, target):
            for kind, field in [('OBJECT', 'objects'), ('COLLECTION', 'collections'), ('ACTION', 'actions')]:
                for name in getattr(source, field):
                    entries.append({'file': str(path.relative_to(library)), 'hash': version, 'kind': kind, 'name': name})
        if checksum(path) != version or len(entries) > 2000:
            raise ValueError('Asset library changed or has too many entries')
    return entries


def import_asset(operation, library, scene):
    relative = Path(operation['file'])
    if relative.is_absolute() or '..' in relative.parts or not relative.parts or relative.suffix != '.blend':
        raise ValueError('Invalid asset path')
    path = within(library / relative, [library])
    if checksum(path) != operation['hash']:
        raise ValueError('Asset version changed; refresh the library')
    field = {'OBJECT': 'objects', 'COLLECTION': 'collections', 'ACTION': 'actions'}.get(operation['asset_type'])
    if not field:
        raise ValueError('Unsupported asset type')
    # Native append reuses Blender dependency resolution, rigs and materials.
    with bpy.data.libraries.load(str(path), link=False, assets_only=True) as (source, target):
        if operation['name'] not in getattr(source, field):
            raise ValueError('Asset is no longer present')
        setattr(target, field, [operation['name']])
    block = getattr(target, field)[0]
    if block is None or checksum(path) != operation['hash']:
        raise ValueError('Asset import failed or changed')
    if field == 'collections':
        scene.collection.children.link(block)
    elif field == 'objects':
        scene.collection.objects.link(block)
    else:
        # Unassigned pose assets must survive checkpoint save/reopen.
        block.use_fake_user = True
    bpy.context.view_layer.update()
    return {'file': operation['file'], 'hash': operation['hash'], 'kind': operation['asset_type'], 'name': block.name}


def apply_pose(operation, scene):
    # Reuse Blender's pose evaluator; accept one local, static rig and one pose asset.
    rig = scene.objects.get(operation['rig'])
    action = bpy.data.actions.get(operation['action'])
    frame = operation['frame']
    if (rig is None or rig.type != 'ARMATURE' or rig.library or rig.override_library
            or rig.data.library or len(rig.users_scene) != 1
            or action is None or not action.asset_data or action.library
            or isinstance(frame, bool) or not isinstance(frame, int)
            or not -1048574 <= frame <= 1048574):
        raise ValueError('Select a local static rig and a local pose asset')
    # Do not silently discard animation, constraints, or drivers to make a pose stick.
    animation = rig.animation_data
    if ((animation and (animation.action or animation.nla_tracks or animation.drivers))
            or rig.data.animation_data or rig.constraints
            or any(bone.constraints for bone in rig.pose.bones)):
        raise ValueError('Animated or constrained rigs need a supported pose workflow')
    if (len(action.slots) != 1 or action.slots[0].target_id_type != 'OBJECT'
            or len(action.layers) != 1 or len(action.layers[0].strips) != 1
            or action.layers[0].strips[0].type != 'KEYFRAME'):
        raise ValueError('Select a single-slot keyframe pose asset')
    bag = action.layers[0].strips[0].channelbag(action.slots[0])
    allowed = {}
    for bone in rig.pose.bones:
        rotation = ('rotation_quaternion', 4) if bone.rotation_mode == 'QUATERNION' else ('rotation_axis_angle', 4) if bone.rotation_mode == 'AXIS_ANGLE' else ('rotation_euler', 3)
        for prop, size in [('location', 3), rotation, ('scale', 3)]:
            allowed[bone.path_from_id(prop)] = size
    if (bag is None or not bag.fcurves or any(
            curve.data_path not in allowed or not 0 <= curve.array_index < allowed[curve.data_path]
            or curve.modifiers or not curve.keyframe_points for curve in bag.fcurves)):
        raise ValueError('Pose channels must address existing bones only')
    # Bone selection belongs to Armature data, which can be shared with another actor.
    rig.data = rig.data.copy()
    for bone in rig.data.bones:
        bone.select = False
    rig.pose.apply_pose_from_action(action, evaluation_time=frame)
    bpy.context.view_layer.update()
    return {'rig': rig.name, 'action': action.name, 'frame': frame}


def vector(value, limit):
    if (not isinstance(value, list) or len(value) != 3 or any(
            isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n)
            or abs(n) > limit for n in value)):
        raise ValueError('Invalid bounded vector')
    return value


def editable_object(scene, name):
    obj = scene.objects.get(name)
    if (obj is None or obj.library or obj.override_library or len(obj.users_scene) != 1
            or obj.parent or obj.constraints or obj.animation_data):
        raise ValueError('Select a local static root object without constraints')
    return obj


def direct_operation(operation, scene):
    from mathutils import Vector
    kind = operation['kind']
    if kind == 'transform':
        obj = editable_object(scene, operation['object'])
        obj.location = vector(operation['location'], 10000)
        obj.rotation_mode = 'XYZ'
        obj.rotation_euler = vector(operation['rotation'], math.tau)
    elif kind == 'aim':
        location = Vector(vector(operation['location'], 10000))
        target = Vector(vector(operation['target'], 10000))
        lens = operation['lens']
        if (isinstance(lens, bool) or not isinstance(lens, (int, float))
                or not math.isfinite(lens) or not 10 <= lens <= 250 or (target - location).length < 0.001):
            raise ValueError('Invalid camera target or lens')
        camera_state(scene)
        camera = editable_object(scene, scene.camera.name)
        camera.data = camera.data.copy()
        camera.location = location
        camera.rotation_mode = 'XYZ'
        camera.rotation_euler = (target - location).to_track_quat('-Z', 'Y').to_euler()
        camera.data.lens = lens
    elif kind == 'light':
        obj = editable_object(scene, operation['object'])
        color = vector(operation['color'], 1)
        energy = operation['energy']
        if (obj.type != 'LIGHT' or any(n < 0 for n in color) or isinstance(energy, bool)
                or not isinstance(energy, (int, float)) or not math.isfinite(energy) or not 0 <= energy <= 100000):
            raise ValueError('Invalid light')
        obj.data = obj.data.copy()
        obj.data.energy = energy
        obj.data.color = color
    bpy.context.view_layer.update()


def object_state(scene):
    return [{'name': o.name, 'type': o.type, 'location': list(o.location),
             'rotation': list(o.rotation_euler), 'dimensions': list(o.dimensions),
             'parent': o.parent.name if o.parent else None,
             'editable': not (o.library or o.override_library or len(o.users_scene) != 1
                              or o.parent or o.constraints or o.animation_data),
             'energy': o.data.energy if o.type == 'LIGHT' else None,
             'color': list(o.data.color) if o.type == 'LIGHT' else None}
            for o in scene.objects]


def pin_dependencies(roots):
    before = dependencies(roots)
    # Blender owns packing and reference resolution; no second asset store is introduced.
    # Blender only packs linked libraries referenced relatively to the current
    # checkpoint. Validate the absolute source first, then rewrite that reference.
    current_dir = Path(bpy.data.filepath).resolve(strict=True).parent
    for linked in bpy.data.libraries:
        absolute = within(bpy.path.abspath(linked.filepath), roots)
        linked.filepath = bpy.path.relpath(str(absolute), start=str(current_dir))
    # Linked blend libraries must be packed before generic external files.
    if bpy.data.libraries and bpy.ops.file.pack_libraries() != {'FINISHED'}:
        raise ValueError('Blender could not pack linked libraries')
    if bpy.ops.file.pack_all() != {'FINISHED'}:
        raise ValueError('Blender could not pack dependencies')
    if dependencies(roots):
        raise ValueError('Unpinned dependencies remain')
    return before


def execute(request):
    if set(request) != {'input', 'input_hash', 'library_root', 'output_root', 'operation'}:
        raise ValueError('Invalid request fields')
    if bpy.app.version != (4, 5, 13):
        raise ValueError('This bridge requires Blender 4.5.13')
    library = Path(request['library_root']).resolve(strict=True)
    output = Path(request['output_root']).resolve(strict=True)
    if any(output.iterdir()):
        raise ValueError('Output folder must be a new private job folder')
    source = Path(request['input']).resolve(strict=True)
    if checksum(source) != request['input_hash']:
        raise ValueError('Input checkpoint changed')
    operation = request['operation']
    kind = operation.get('kind')
    allowed = {'transform': {'kind', 'object', 'location', 'rotation'}, 'aim': {'kind', 'location', 'target', 'lens'}, 'light': {'kind', 'object', 'energy', 'color'}, 'pose': {'kind', 'rig', 'action', 'frame'}, 'inspect': {'kind'}, 'camera': {'kind', 'lens'}, 'capture': {'kind', 'width', 'height'}, 'shot': {'kind', 'scene', 'camera', 'frame'}, 'catalog': {'kind'}, 'import': {'kind', 'file', 'hash', 'asset_type', 'name'}}
    if kind not in allowed or set(operation) != allowed[kind]:
        raise ValueError('Unsupported operation or unexpected arguments')
    bpy.context.preferences.filepaths.use_scripts_auto_execute = False
    bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
    roots = [library, source.parent]
    dependencies(roots)
    catalog = library_assets(library) if kind == 'catalog' else None
    imported = None
    applied_pose = None
    scene = bpy.context.scene
    if kind == 'import':
        imported = import_asset(operation, library, scene)
    if kind == 'shot':
        scene = bpy.data.scenes.get(operation['scene'])
        if scene is None or scene.library:
            raise ValueError('Select a local Blender scene')
        camera = scene.objects.get(operation['camera'])
        frame = operation['frame']
        if camera is None or camera.type != 'CAMERA' or isinstance(frame, bool) or not isinstance(frame, int) or not -1048574 <= frame <= 1048574:
            raise ValueError('Invalid camera or frame')
        bpy.context.window.scene = scene
        scene.camera = camera
        scene.frame_set(frame)
    if kind == 'camera':
        lens = operation['lens']
        if isinstance(lens, bool) or not isinstance(lens, (int, float)) or not math.isfinite(lens) or not 10 <= lens <= 250:
            raise ValueError('Lens must be between 10 and 250 mm')
        camera_state(scene)
        # Separate the camera object and its data; another scene may share both.
        camera = scene.camera.copy()
        camera.data = scene.camera.data.copy()
        scene.collection.objects.link(camera)
        scene.camera = camera
        scene.camera.data.lens = lens
        bpy.context.view_layer.update()
    if kind in {'transform', 'aim', 'light'}:
        direct_operation(operation, scene)
    if kind == 'pose':
        applied_pose = apply_pose(operation, scene)
    # Pack before rendering or persisting any new version. Unsupported dependencies fail closed.
    pinned_from = pin_dependencies(roots)
    image = None
    if kind == 'capture':
        for field in ['width', 'height']:
            value = operation[field]
            if isinstance(value, bool) or not isinstance(value, int) or not 64 <= value <= 4096:
                raise ValueError('Capture dimension must be 64..4096')
        camera_state(scene)
        scene.render.resolution_x = operation['width']
        scene.render.resolution_y = operation['height']
        scene.render.resolution_percentage = 100
        scene.render.use_compositing = False
        scene.render.use_sequencer = False
        scene.render.image_settings.file_format = 'PNG'
        scene.render.image_settings.color_depth = '8'
        scene.render.image_settings.color_mode = 'RGBA'
        scene.render.filepath = str(output / 'capture.png')
        bpy.ops.render.render(write_still=True)
        image = {'file': 'capture.png', 'hash': checksum(output / 'capture.png')}
    checkpoint = output / 'checkpoint.blend'
    bpy.ops.wm.save_as_mainfile(filepath=str(checkpoint), check_existing=False, copy=True)
    # Reopen the actual saved pack and verify that no mutable external inputs remain.
    bpy.ops.wm.open_mainfile(filepath=str(checkpoint), load_ui=False, use_scripts=False)
    remaining = dependencies([output])
    if remaining:
        raise ValueError('Saved checkpoint still depends on external files')
    scene = bpy.context.scene
    result = {
        'protocol': 1, 'blender_version': list(bpy.app.version),
        'blender_build': bpy.app.build_hash.decode(), 'gui_required': False,
        'operations': ['inspect', 'camera', 'capture', 'shot', 'catalog', 'import', 'pose', 'transform', 'aim', 'light'], 'passes': ['color'],
        'checkpoint': {'file': checkpoint.name, 'hash': checksum(checkpoint)},
        'image': image, 'state': camera_state(scene), 'dependencies': remaining, 'packed_sources': pinned_from,
        'dependencies_pinned': True,
        'applied_pose': applied_pose,
        'rigs': [obj.name for obj in scene.objects if obj.type == 'ARMATURE'],
        'objects': object_state(scene), 'assets': asset_state(), 'library_assets': catalog, 'imported_asset': imported,
        'scenes': [{'name': item.name, 'cameras': [obj.name for obj in item.objects if obj.type == 'CAMERA'],
                    'objects': [obj.name for obj in item.objects], 'frame': item.frame_current} for item in bpy.data.scenes],
    }
    target = output / 'result.json'
    with target.open('x') as stream:
        json.dump(result, stream)
        stream.flush()
        os.fsync(stream.fileno())


if __name__ == '__main__':
    try:
        data = sys.stdin.buffer.read(65537)
        if len(data) > 65536:
            raise ValueError('Request too large')
        execute(json.loads(data))
        print('MANGA_BLENDER_COMPLETE')
    except Exception:
        # Production errors stay generic. The acceptance harness enables a traceback
        # only inside its isolated fixture workspace so CI can diagnose regressions.
        if os.environ.get('MANGA_BLENDER_TEST_DIAGNOSTICS') == '1':
            import traceback
            traceback.print_exc()
        print('MANGA_BLENDER_FAILED', file=sys.stderr)
        sys.exit(1)
