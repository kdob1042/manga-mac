"""Synthetic public fixture, not a production character/quality acceptance scene."""
import bpy
import os
from pathlib import Path
root = Path(os.environ['DIRECTION_FIXTURES'])
root.mkdir(parents=True, exist_ok=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 4
scene.camera.data.lens = 35
bpy.ops.wm.save_as_mainfile(filepath=str(root / 'fixture.blend'))
