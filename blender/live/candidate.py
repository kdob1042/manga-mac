"""Render and save one immutable GUI candidate on Blender's main thread."""
import bpy
import base64
import tempfile
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
    # Only dependencies already referenced by this explicitly selected GUI state.
    pinned = pin_dependencies(None)
    r = scene.render
    old = {k: getattr(r, k) for k in ('filepath', 'resolution_x', 'resolution_y', 'resolution_percentage', 'use_compositing', 'use_sequencer')}
    image_old = {k: getattr(r.image_settings, k) for k in ('file_format', 'color_mode', 'color_depth')}
    with tempfile.TemporaryDirectory(prefix='manga-live-candidate-') as folder:
        path, image = Path(folder)/'checkpoint.blend', Path(folder)/'capture.png'
        try:
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
            for k, v in old.items(): setattr(r, k, v)
            for k, v in image_old.items(): setattr(r.image_settings, k, v)
