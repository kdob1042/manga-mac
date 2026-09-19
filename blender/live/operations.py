"""Allowlisted property operations only. RNA discovery is not execution permission."""
import bpy
import math
from .observation import object_id


def scalar(value, low, high):
    if type(value) not in (float, int) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError('invalid operation value')
    return value


def apply(op):
    kind = op.get('kind')
    keys = {'camera': {'kind', 'object', 'object_id', 'value'},
            'constraint': {'kind', 'object', 'object_id', 'constraint', 'value'},
            'transform': {'kind', 'object', 'object_id', 'location'}}
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
        value = op['location']
        if not isinstance(value, list) or len(value) != 3:
            raise ValueError('invalid location')
        value = [scalar(x, -10000, 10000) for x in value]
        before = list(obj.location)
        obj.location = value
        actual = list(obj.location)
    bpy.context.view_layer.update()
    # read back actual configured value; visual/evaluated effect remains a separate check
    return {'before': before, 'actual': actual, 'changed': before != actual,
            'object_id': object_id(obj), 'operation': op}
