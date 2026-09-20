"""Read Blender's evaluated state; do not create an application scene graph."""
import bpy
import base64
import hashlib
import json
import tempfile
from pathlib import Path
from .viewport import ViewportCapture


def matrix(m):
    return [list(row) for row in m]


def object_id(obj):
    # Scoped to epoch. Rename preserves identity; duplicate gets a different pointer.
    return str(obj.as_pointer())


def constraints(obj):
    return [{"name": c.name, "type": c.type, "influence": c.influence,
             "range": [0, 1], "target": getattr(getattr(c, 'target', None), 'name', None)} for c in obj.constraints]


def fingerprint():
    c = bpy.context
    # Read again even if no depsgraph notification arrived. Hash isn't sent to LLM.
    values = [(object_id(o), o.name, matrix(o.matrix_world), constraints(o),
               str(dict(o.items())), getattr(o.data, 'lens', None),
               [(b.name, matrix(b.matrix), constraints(b)) for b in o.pose.bones] if o.pose else [])
              for o in c.scene.objects]
    values.append((bpy.data.filepath, c.scene.name, c.scene.frame_current, c.view_layer.name,
                   c.scene.camera.name if c.scene.camera else None, c.mode,
                   [object_id(o) for o in c.selected_objects]))
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()


def observe(args):
    c = bpy.context
    scope = args.get('scope', 'summary')
    if scope == 'summary':
        offset = args.get('offset', 0)
        if type(offset) is not int or offset < 0:
            raise ValueError('invalid observation offset')
        objects = list(c.scene.objects)
        camera = c.scene.camera
        return {"frame": c.scene.frame_current, "object_mode": c.mode,
                "selection": [{"id": object_id(o), "name": o.name} for o in c.selected_objects],
                "objects": [{"id": object_id(o), "name": o.name, "type": o.type} for o in objects[offset:offset+100]],
                "next_offset": offset+100 if len(objects) > offset+100 else None,
                "lens": camera.data.lens if camera else None,
                "camera_state": {"local": matrix(camera.matrix_local), "evaluated_world": matrix(camera.evaluated_get(c.evaluated_depsgraph_get()).matrix_world)} if camera else None,
                "capabilities": ["summary", "object", "viewport", "camera"],
                "addons": sorted(c.preferences.addons.keys())}
    if scope == 'object':
        obj = c.scene.objects.get(args.get('object', ''))
        if obj is None:
            raise ValueError('target_unknown: object not in current scene')
        evaluated = obj.evaluated_get(c.evaluated_depsgraph_get())
        props = {}
        for key in obj.keys():
            value = obj[key]
            if type(value) in (int, float, bool, str):
                props[key] = {"value": value, "schema": obj.id_properties_ui(key).as_dict()}
        return {"id": object_id(obj), "name": obj.name, "type": obj.type,
                "rotation": list(obj.rotation_euler), "location": list(obj.location),
                "local": matrix(obj.matrix_local), "world": matrix(obj.matrix_world),
                "evaluated_world": matrix(evaluated.matrix_world), "parent": obj.parent.name if obj.parent else None,
                "constraints": constraints(obj), "custom_properties": props,
                "rig": [{"name": b.name, "constraints": constraints(b), "rotation_mode": b.rotation_mode} for b in obj.pose.bones] if obj.pose else [],
                "property_schema": {"constraint.influence": {"type": "number", "minimum": 0, "maximum": 1}},
                "operators": []}
    if scope in ('viewport', 'camera'):
        with tempfile.TemporaryDirectory(prefix='manga-live-preview-') as folder:
            path = str(Path(folder) / 'preview.png')
            if scope == 'viewport':
                result = ViewportCapture().get_viewport_screenshot(max_size=800, filepath=path)
                if not result.get('success'):
                    raise ValueError(result.get('error', 'viewport unavailable'))
                method = result['method']
            else:
                scene = c.scene
                if not scene.camera:
                    raise ValueError('target_unknown: no camera')
                r = scene.render
                old = (r.filepath, r.resolution_percentage, r.image_settings.file_format)
                try:
                    r.filepath = path
                    r.resolution_percentage = max(1, min(100, int(80000 / max(r.resolution_x, r.resolution_y))))
                    r.image_settings.file_format = 'PNG'
                    bpy.ops.render.render(write_still=True)
                finally:
                    r.filepath, r.resolution_percentage, r.image_settings.file_format = old
                method = 'camera_render'
            return {"image_kind": scope, "method": method, "image": 'data:image/png;base64,' + base64.b64encode(Path(path).read_bytes()).decode()}
    raise ValueError('unsupported observation')
