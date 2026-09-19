"""Package only reviewed local code; no network or dependency installation."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
root = Path(__file__).resolve().parent.parent
output = root / 'dist' / 'manga_mac_live.zip'
output.parent.mkdir(exist_ok=True)
with ZipFile(output, 'w', ZIP_DEFLATED) as z:
    for name in ['__init__.py', 'viewport.py', 'observation.py', 'operations.py', 'candidate.py', 'LICENSE.upstream', 'upstream.json']:
        z.write(root / 'blender' / 'live' / name, 'manga_mac_live/' + name)
print(output)
