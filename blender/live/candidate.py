"""Render and save one immutable GUI candidate on Blender's main thread."""
import bpy
import base64
import tempfile
import math
from .operations import apply, scalar
from .observation import object_id
from pathlib import Path
from .capture_support import checksum, camera_state, pin_dependencies, dependencies


def export_copy(args):
    if bpy.app.background or bpy.context.mode != 'OBJECT':
        raise ValueError('Use the connected Blender GUI in Object mode')
    if bpy.app.version != (4, 5, 13):
        raise ValueError('Candidate capture requires Blender 4.5.13')
    width, height = args.get('width', 768), args.get('height', 768)
    if any(type(n) is not int or not 64 <= n <= 4096 for n in (width, height)):
        raise ValueError('Capture dimension must be 64..4096')
    scene = bpy.context.scene
    camera_state(scene)
    camera = scene.camera
    original_location, original_rotation = camera.location.copy(), camera.rotation_euler.copy()
    angle = args.get('angle')
    angle_location = None
    if angle is not None:
        if not isinstance(angle, dict) or set(angle) != {'degrees', 'target'}:
            raise ValueError('Invalid angle request')
        if camera.library or camera.parent or camera.constraints or camera.animation_data or camera.data.animation_data or camera.rotation_mode != 'XYZ':
            raise ValueError('operation_unsupported: angle capture needs a static independent camera')
        degrees = scalar(angle['degrees'], -180, 180)
        target = angle['target']
        if not isinstance(target, list) or len(target) != 3:
            raise ValueError('Invalid angle target')
        target = [scalar(x, -10000, 10000) for x in target]
        dx, dy, dz = [original_location[i] - target[i] for i in range(3)]
        if math.hypot(dx, dy) < 1e-6:
            raise ValueError('Camera must have a horizontal distance from the angle target')
        radians = math.radians(degrees)
        angle_location = [target[0]+dx*math.cos(radians)-dy*math.sin(radians),
                          target[1]+dx*math.sin(radians)+dy*math.cos(radians), target[2]+dz]
        angle_location = [scalar(x, -10000, 10000) for x in angle_location]
    # Only dependencies already referenced by this explicitly selected GUI state.
    pinned = pin_dependencies(None)
    r = scene.render
    old = {k: getattr(r, k) for k in ('filepath', 'resolution_x', 'resolution_y', 'resolution_percentage', 'use_compositing', 'use_sequencer')}
    image_old = {k: getattr(r.image_settings, k) for k in ('file_format', 'color_mode', 'color_depth')}
    with tempfile.TemporaryDirectory(prefix='manga-live-candidate-') as folder:
        path, image = Path(folder)/'checkpoint.blend', Path(folder)/'capture.png'
        try:
            if angle_location is not None:
                common = {'object': camera.name, 'object_id': object_id(camera)}
                apply({'kind': 'transform', **common, 'location': angle_location})
                apply({'kind': 'aim', **common, 'target': target})
            r.resolution_x, r.resolution_y, r.resolution_percentage = width, height, 100
            r.use_compositing = r.use_sequencer = False
            r.image_settings.file_format, r.image_settings.color_mode, r.image_settings.color_depth = 'PNG', 'RGBA', '8'
            r.filepath = str(image)
            # Synchronous render + copy: GUI events and queued MCP writes cannot interleave.
            bpy.ops.render.render(write_still=True)
            state = camera_state(scene)
            if dependencies(None):
                raise ValueError('Unpinned dependencies remain')
            if bpy.ops.wm.save_as_mainfile(filepath=str(path), copy=True, check_existing=False) != {'FINISHED'}:
                raise ValueError('Candidate copy could not be saved')
            if not path.is_file() or path.stat().st_size > 64*1024*1024 or image.stat().st_size > 4*1024*1024:
                raise ValueError('Candidate transfer exceeds 64 MiB blend / 4 MiB PNG limit')
            result = {'protocol': 1, 'blender_version': list(bpy.app.version), 'blender_build': bpy.app.build_hash.decode(),
                      'gui_required': True, 'operations': [], 'passes': ['color'], 'state': state,
                      'checkpoint': {'file': path.name, 'hash': checksum(path)}, 'image': {'file': image.name, 'hash': checksum(image)},
                      'dependencies_pinned': True, 'dependencies': [], 'packed_sources': pinned,
                      'scenes': [{'name': s.name, 'objects': [o.name for o in s.objects], 'cameras': [o.name for o in s.objects if o.type == 'CAMERA']} for s in bpy.data.scenes]}
            return {'blend': base64.b64encode(path.read_bytes()).decode(), 'sha256': result['checkpoint']['hash'],
                    'preview': 'data:image/png;base64,'+base64.b64encode(image.read_bytes()).decode(), 'state': result}
        finally:
            if angle_location is not None:
                camera.location, camera.rotation_euler = original_location, original_rotation
            for k, v in old.items(): setattr(r, k, v)
            for k, v in image_old.items(): setattr(r.image_settings, k, v)
            # Flush both camera and render-setting restoration before publishing identity.
            bpy.context.view_layer.update()
