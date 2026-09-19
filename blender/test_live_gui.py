"""Actual GUI/MCP acceptance fixture (Linux/Xvfb); never touches a user's Blender."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
import uuid

ROOT = Path(__file__).resolve().parent.parent
BOOTSTRAP = '''
import bpy, sys, json, os
from pathlib import Path
sys.path.insert(0, ROOT)
from blender import live
live.register()
bpy.context.window_manager.manga_live_port = PORT
bpy.ops.manga_live.start()
bpy.context.scene.camera.data.lens = 35
constraint = bpy.data.objects['Cube'].constraints.new('COPY_LOCATION')
constraint.name = 'LiveTest'
constraint.target = bpy.context.scene.camera
constraint.influence = .5
Path(CONFIG).write_text(json.dumps({'token':live.TOKEN,'instance':live.INSTANCE}))
os.chmod(CONFIG, 0o600)
def manual_edit():
    marker = Path(MARKER)
    if marker.exists():
        bpy.context.scene.camera.data.lens = 42
        bpy.context.scene.frame_set(7)
        marker.unlink()
    return .05
bpy.app.timers.register(manual_edit)
'''


def main():
    binary, output = sys.argv[1:3]
    out = Path(output)
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as folder:
        folder = Path(folder)
        config, marker = folder/'connection.json', folder/'manual'
        # Ask OS for an unused loopback port; only this test process uses it.
        import socket
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        bootstrap = folder/'bootstrap.py'
        bootstrap.write_text(f'ROOT={str(ROOT)!r}\nPORT={port}\nCONFIG={str(config)!r}\nMARKER={str(marker)!r}\n'+BOOTSTRAP)
        with (out/'live-gui.log').open('w') as log:
            process = subprocess.Popen([binary,'--factory-startup','--disable-autoexec','--python',str(bootstrap)], stdout=log, stderr=log)
            try:
                for _ in range(300):
                    if config.exists(): break
                    if process.poll() is not None: raise RuntimeError('Blender GUI startup failed')
                    time.sleep(.1)
                credentials = json.loads(config.read_text())
                client = str(uuid.uuid4())
                def rpc(method, params=None, token=None):
                    request = urllib.request.Request(f'http://127.0.0.1:{port}/mcp',
                        data=json.dumps({'jsonrpc':'2.0','id':str(uuid.uuid4()),'method':method,'params':params or {}}).encode(),
                        headers={'Authorization':'Bearer '+(token if token is not None else credentials['token']),'Content-Type':'application/json'})
                    with urllib.request.urlopen(request, timeout=40) as response:
                        data=json.load(response)
                    if 'error' in data: raise RuntimeError(data['error']['message'])
                    return data['result']
                def tool(name, **args):
                    args['client']=client
                    result=rpc('tools/call',{'name':name,'arguments':args})
                    return json.loads(result['content'][0]['text'])
                assert rpc('initialize')['serverInfo']['name']=='manga-mac-live'
                try: rpc('ping',token='wrong')
                except urllib.error.HTTPError as e: assert e.code==403
                else: raise AssertionError('bad token accepted')
                original=tool('live_identity')
                assert original['file']==''
                tool('live_claim',instance=credentials['instance'],epoch=original['epoch'])
                first=tool('live_observe',scope='summary')
                marker.touch()
                for _ in range(100):
                    current=tool('live_observe',scope='summary')
                    if current['frame']==7: break
                    time.sleep(.1)
                assert current['lens']==42 and current['file']=='' and current['revision']!=first['revision']
                obj=tool('live_observe',scope='object',object='Cube')
                assert obj['world'] and obj['evaluated_world'] and obj['constraints'][0]['name']=='LiveTest'
                tool('live_resume',expected=tool('live_identity'))
                op={'kind':'constraint','object':'Cube','object_id':obj['id'],'constraint':'LiveTest','value':.25}
                try: tool('live_act',expected=first,operation=op,request_id=str(uuid.uuid4()))
                except RuntimeError as e: assert 'stale_observation' in str(e)
                else: raise AssertionError('stale write accepted')
                result=tool('live_act',expected=tool('live_identity'),operation=op,request_id=str(uuid.uuid4()))
                assert result['changed'] and abs(result['actual']-.25)<1e-6
                tool('live_handoff')
                try: tool('live_act',expected=tool('live_identity'),operation=op,request_id=str(uuid.uuid4()))
                except RuntimeError as e: assert 'manual_control' in str(e)
                else: raise AssertionError('manual write accepted')
                for kind in ('viewport','camera'):
                    image=tool('live_observe',scope=kind)
                    assert image['image_kind']==kind
                    data=base64.b64decode(image['image'].split(',',1)[1])
                    assert data.startswith(b'\x89PNG')
                    (out/f'live-{kind}.png').write_bytes(data)
                saved=tool('live_candidate',expected=tool('live_identity'))
                assert base64.b64decode(saved['blend']).startswith(b'BLENDER')
                assert tool('live_identity')['file']=='' # save copy never changed active file
                tool('live_release')
                (out/'live-acceptance.json').write_text(json.dumps({'platform':'Linux GUI under Xvfb','status':'pass','checks':['auth','unsaved manual state','evaluated state','stale rejection','constraint write','handoff blocks write','viewport','camera','immutable copy']},indent=2))
                print('Live GUI/MCP acceptance: PASS')
            finally:
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill(); process.wait()

if __name__ == '__main__': main()
