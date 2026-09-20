"""Shared Blender packing and camera metadata, used by GUI capture and legacy fixtures."""
import bpy
import hashlib
from pathlib import Path


def checksum(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def within(path, roots):
    path = Path(path).resolve(strict=True)
    if roots is not None and not any(path.is_relative_to(root) for root in roots):
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


def pin_dependencies(roots):
    before = dependencies(roots)
    # Blender owns packing and reference resolution; no second asset store is introduced.
    # Blender only packs linked libraries referenced relatively to the current
    # checkpoint. Validate the absolute source first, then rewrite that reference.
    current_dir = Path(bpy.data.filepath).resolve(strict=True).parent if bpy.data.filepath else None
    if bpy.data.libraries and current_dir is None:
        raise ValueError("Save a working blend before packing linked libraries")
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

