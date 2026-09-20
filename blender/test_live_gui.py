"""Actual GUI/MCP acceptance fixture (Linux/Xvfb or macOS GUI); never touches a user's Blender."""
import base64
import json
import os
import platform
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
import bpy, sys, json, os, time, threading, urllib.request
from pathlib import Path
sys.path.insert(0, ROOT)
from blender import live
live.register()
bpy.context.window_manager.manga_live_port = PORT
bpy.ops.manga_live.start()
assert not bpy.app.background and bpy.context.window_manager.windows, 'Real GUI required'
Path(ENVIRONMENT).write_text(json.dumps({'blender': bpy.app.version_string,
    'background': bpy.app.background, 'windows': len(bpy.context.window_manager.windows),
    'render_engine': bpy.context.scene.render.engine}))
bpy.context.scene.camera.data.lens = 35
constraint = bpy.data.objects['Cube'].constraints.new('COPY_LOCATION')
constraint.name = 'LiveTest'
constraint.target = bpy.context.scene.camera
constraint.influence = .5
Path(CONFIG).write_text(json.dumps({'token':live.TOKEN,'instance':live.INSTANCE}))
os.chmod(CONFIG, 0o600)
def manual_edit():
    marker = Path(MARKER)
    stop_marker = Path(MARKER + '.stop')
    if stop_marker.exists():
        bpy.app.timers.unregister(live.pump)
        token = live.TOKEN
        def pending_request():
            request = urllib.request.Request(f'http://127.0.0.1:{PORT}/mcp',
                data=json.dumps({'jsonrpc':'2.0','id':'pending','method':'ping'}).encode(),
                headers={'Authorization':'Bearer '+token})
            try:
                urllib.request.urlopen(request, timeout=5).close()
            except Exception:
                pass
        threading.Thread(target=pending_request, daemon=True).start()
        deadline = time.monotonic() + 3
        while live.QUEUE.empty() and time.monotonic() < deadline:
            time.sleep(.01)
        assert not live.QUEUE.empty(), 'fixture request never queued'
        started = time.monotonic()
        live.stop()
        assert time.monotonic() - started < 2, 'stop blocked GUI on pending request'
        # A request queued by the old authenticated session must not run later.
        live.pump()
        Path(MARKER + '.stopped').touch()
        return None
    command_file = Path(MARKER + '.command')
    if command_file.exists():
        command = command_file.read_text()
        command_file.unlink()
        try:
            if command == 'load':
                bpy.ops.wm.open_mainfile(filepath=WORKFILE)
            else:
                window = bpy.context.window_manager.windows[0]
                area = next(a for a in window.screen.areas if a.type == 'VIEW_3D')
                region = next(r for r in area.regions if r.type == 'WINDOW')
                with bpy.context.temp_override(window=window, area=area, region=region):
                    if command == 'prepare_undo':
                        bpy.ops.ed.undo_push(message='Live before edit')
                        bpy.context.scene.camera.data.lens = 50
                        bpy.ops.ed.undo_push(message='Live after edit')
                    elif command == 'undo':
                        bpy.ops.ed.undo()
                    elif command == 'redo':
                        bpy.ops.ed.redo()
                    else:
                        raise ValueError('Unknown fixture command')
            result = {'command': command, 'success': True}
        except Exception as exc:
            result = {'command': command, 'success': False, 'error': str(exc)}
        Path(MARKER + '.result').write_text(json.dumps(result))
    if marker.exists():
        bpy.context.scene.camera.data.lens = 42
        bpy.context.scene.frame_set(7)
        marker.unlink()
    return .05
bpy.app.timers.register(manual_edit, persistent=True)
'''


def main():
    binary, output = sys.argv[1:3]
    out = Path(output).resolve()
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
        workfile = folder/'working-copy.blend'
        bootstrap.write_text(f'ROOT={str(ROOT)!r}\nPORT={port}\nCONFIG={str(config)!r}\nMARKER={str(marker)!r}\nWORKFILE={str(workfile)!r}\nENVIRONMENT={str(out / "blender-environment.json")!r}\n'+BOOTSTRAP)
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
                    with urllib.request.urlopen(request, timeout=190) as response:
                        data=json.load(response)
                    if 'error' in data: raise RuntimeError(data['error']['message'])
                    return data['result']
                def tool(name, **args):
                    args['client']=client
                    result=rpc('tools/call',{'name':name,'arguments':args})
                    return json.loads(result['content'][0]['text'])
                transitions = []
                images = []
                def fixture(command):
                    reply = Path(str(marker)+'.result')
                    reply.unlink(missing_ok=True)
                    Path(str(marker)+'.command').write_text(command)
                    for _ in range(200):
                        if reply.exists(): break
                        if process.poll() is not None: raise RuntimeError('Blender GUI exited')
                        time.sleep(.1)
                    result = json.loads(reply.read_text())
                    assert result.get('success') and result['command'] == command, result
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
                transitions.append({'event':'frame/manual edit','before':first,'after':current})
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
                    print('Observing live image:', kind, flush=True)
                    image=tool('live_observe',scope=kind)
                    assert image['image_kind']==kind
                    data=base64.b64decode(image['image'].split(',',1)[1])
                    assert data.startswith(b'\x89PNG')
                    assert image['instance']==original['instance'] and image['epoch']==original['epoch']
                    assert isinstance(image['revision'],int)
                    images.append({k:image.get(k) for k in ('image_kind','method','instance','epoch','revision','file','scene','view_layer')})
                    (out/f'live-{kind}.png').write_bytes(data)
                saved=tool('live_candidate',expected=tool('live_identity'))
                blend = base64.b64decode(saved['blend'])
                assert blend.startswith(b'BLENDER')
                workfile.write_bytes(blend)
                assert tool('live_identity')['file']=='' # save copy never changed active file
                released = tool('live_release')
                assert released['control']=='manual'
                try: tool('live_observe',scope='summary')
                except RuntimeError as e: assert 'session mismatch' in str(e)
                else: raise AssertionError('released session stayed authorized')
                tool('live_claim',instance=original['instance'],epoch=released['epoch'])
                assert tool('live_observe',scope='summary')['file']==''
                fixture('prepare_undo')
                assert tool('live_observe',scope='summary')['lens']==50
                for command, lens in [('undo',42),('redo',50),('load',42)]:
                    before = tool('live_identity')
                    fixture(command)
                    after = tool('live_identity')
                    assert before['instance']==after['instance'] and before['epoch']!=after['epoch'], command
                    assert after['control']=='manual'
                    try: tool('live_observe',scope='summary')
                    except RuntimeError as e: assert 'session mismatch' in str(e)
                    else: raise AssertionError('old client survived '+command)
                    tool('live_claim',instance=after['instance'],epoch=after['epoch'])
                    observed = tool('live_observe',scope='summary')
                    assert observed['lens']==lens, (command,observed['lens'])
                    tool('live_resume',expected=tool('live_identity'))
                    try: tool('live_act',expected=before,operation=op,request_id=str(uuid.uuid4()))
                    except RuntimeError as e: assert 'stale_observation' in str(e)
                    else: raise AssertionError('old observation survived '+command)
                    tool('live_handoff')
                    transitions.append({'event':command,'before':before,'after':after})
                assert tool('live_identity')['file']==str(workfile)
                tool('live_release')
                Path(str(marker)+'.stop').touch()
                for _ in range(80):
                    if Path(str(marker)+'.stopped').exists(): break
                    time.sleep(.1)
                assert Path(str(marker)+'.stopped').exists(), 'GUI stop/revocation failed'
                (out/'live-acceptance.json').write_text(json.dumps({'platform':platform.platform(),'gui':'macOS GUI' if sys.platform=='darwin' else 'Linux GUI under Xvfb','status':'pass','images':images,'transitions':transitions,'checks':['auth','unsaved manual state','evaluated state','stale rejection','constraint write','handoff blocks write','viewport','camera','immutable copy','pending request stop','release/reconnect','undo invalidation','redo invalidation','file load invalidation']},indent=2))
                print('Live GUI/MCP acceptance: PASS')
            finally:
                log.flush()
                print((out/'live-gui.log').read_text(errors='replace')[-8000:], flush=True)
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill(); process.wait()

if __name__ == '__main__': main()
