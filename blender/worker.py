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
        paths.add(within(bpy.path.abspath(library.filepath), roots))
    for image in bpy.data.images:
        if image.source == 'FILE' and not image.packed_file and image.filepath:
            paths.add(within(bpy.path.abspath(image.filepath, library=image.library), roots))
    # Fail closed for dependency forms that this initial bridge cannot pin.
    if any(image.source in {'MOVIE', 'SEQUENCE', 'TILED'} for image in bpy.data.images):
        raise ValueError('Animated or tiled textures need a supported capture adapter')
    if bpy.data.movieclips or bpy.data.sounds or bpy.data.cache_files or bpy.data.volumes:
        raise ValueError('External media dependencies are not supported by this bridge')
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
    }


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
    allowed = {'inspect': {'kind'}, 'camera': {'kind', 'lens'}, 'capture': {'kind', 'width', 'height'}}
    if kind not in allowed or set(operation) != allowed[kind]:
        raise ValueError('Unsupported operation or unexpected arguments')
    bpy.context.preferences.filepaths.use_scripts_auto_execute = False
    bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
    roots = [library, source.parent]
    deps = dependencies(roots)
    scene = bpy.context.scene
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
    result = {
        'protocol': 1, 'blender_version': list(bpy.app.version),
        'blender_build': bpy.app.build_hash.decode(), 'gui_required': False,
        'operations': ['inspect', 'camera', 'capture'], 'passes': ['color'],
        'checkpoint': {'file': checkpoint.name, 'hash': checksum(checkpoint)},
        'image': image, 'state': camera_state(scene), 'dependencies': deps,
        'dependencies_pinned': not deps,
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
        # No manuscript, user paths, or environment values in the public error.
        print('MANGA_BLENDER_FAILED', file=sys.stderr)
        sys.exit(1)
