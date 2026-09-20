"""Trusted GUI bootstrap; configuration is private JSON, never executable input."""
import bpy
import json
import os
import sys
from pathlib import Path

config_path = Path(sys.argv[sys.argv.index('--') + 1])
config = json.loads(config_path.read_text())
root = config_path.parent
sys.path.insert(0, str(root))
import manga_mac_live as live


def start():
    try:
        if bpy.app.background or bpy.app.version[:3] != (4, 5, 13):
            raise RuntimeError('Blender 4.5.13 GUI is required')
        working = Path(config['working'])
        lock = working.parent / 'gui.pid'
        if lock.exists():
            old_pid = int(lock.read_text())
            try:
                os.kill(old_pid, 0)
            except ProcessLookupError:
                lock.unlink()
            else:
                raise RuntimeError('This working file already has an open GUI. Reconnect explicitly.')
        fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(str(os.getpid()))
        if working.exists():
            bpy.ops.wm.open_mainfile(filepath=str(working), load_ui=True, use_scripts=False)
        elif config.get('template'):
            bpy.ops.wm.open_mainfile(filepath=config['template'], load_ui=True, use_scripts=False)
            # Resolve relative dependencies before changing the containing directory.
            from manga_mac_live.capture_support import pin_dependencies
            pin_dependencies(None)
        if not working.exists():
            bpy.ops.wm.save_as_mainfile(filepath=str(working))
        bpy.context.preferences.filepaths.asset_libraries.new(name='Manga Mac', directory=config['assets'])
        live.WORKING_FILE = str(working)
        live.register()
        # The operating system allocates a free loopback port; no port scan or foreign attach.
        import secrets
        import uuid
        import threading
        live.TOKEN = secrets.token_hex(32)
        live.INSTANCE, live.EPOCH = str(uuid.uuid4()), str(uuid.uuid4())
        live.SERVER = live.ThreadingHTTPServer(('127.0.0.1', 0), live.Handler)
        threading.Thread(target=live.SERVER.serve_forever, daemon=True).start()
        bpy.app.timers.register(live.pump, persistent=True)
        wm = bpy.context.window_manager
        wm.manga_live_port = live.SERVER.server_port
        wm.manga_live_token = live.TOKEN
        wm.manga_live_instance = live.INSTANCE
        result = {**live.identity(), 'port': live.SERVER.server_port, 'token': live.TOKEN}
    except Exception as exc:
        result = {'error': str(exc)}
    destination = root / 'ready.json'
    temporary = root / 'ready.tmp'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(result, stream)
    temporary.replace(destination)
    return None


bpy.app.timers.register(start, first_interval=0.5)
