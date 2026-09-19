"""Save a new packed copy only. Never load a file or overwrite the active file."""
import bpy
import base64
import hashlib
import tempfile
from pathlib import Path


def export_copy():
    if bpy.context.mode != 'OBJECT':
        raise ValueError('operation_unsupported: leave Edit/Pose mode before saving candidate')
    with tempfile.TemporaryDirectory(prefix='manga-live-candidate-') as folder:
        path = Path(folder) / 'candidate.blend'
        # Standard Blender packing. Failure must stop the export.
        bpy.ops.file.pack_all()
        bpy.ops.wm.save_as_mainfile(filepath=str(path), copy=True, check_existing=False)
        if not path.is_file() or path.stat().st_size > 64 * 1024 * 1024:
            raise ValueError('candidate exceeds 64 MiB live transfer limit')
        data = path.read_bytes()
        return {'blend': base64.b64encode(data).decode(), 'sha256': hashlib.sha256(data).hexdigest()}
