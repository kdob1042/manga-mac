"""Codex client for an explicitly handed-off session. No code/path execution API."""
import argparse
import fcntl
import json
import os
import pathlib
import tempfile
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('session')
parser.add_argument('operation', choices=['state', 'transform', 'handoff', 'snapshot', 'recover'])
parser.add_argument('--arguments', default='{}', help='Typed arguments, including instance/document/revision from state')
args = parser.parse_args()
session = str(uuid.UUID(args.session))
root = pathlib.Path(tempfile.gettempdir()) / ('manga-compositor-' + session)
info = root.lstat()
if root.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o777 != 0o700:
    raise SystemExit('Invalid session directory')
config = json.loads((root / 'connection.json').read_text())
if config['session'] != session:
    raise SystemExit('Session mismatch')
lock_path = root / 'ipc.lock'
if lock_path.is_symlink():
    raise SystemExit('Invalid lock')
with lock_path.open('a+') as gate:
    fcntl.flock(gate, fcntl.LOCK_EX | fcntl.LOCK_NB)
    pending = root / 'pending.json'
    if args.operation == 'recover':
        request_id = str(uuid.UUID(json.loads(pending.read_text())['id']))
    else:
        if pending.exists():
            raise SystemExit('Previous result is unknown; use recover without resending')
        request_id = str(uuid.uuid4())
        request = {**json.loads(args.arguments), 'id':request_id, 'protocol':1, 'session':session,
                   'token':config['token'], 'actor':'codex', 'op':args.operation}
        pending.write_text(json.dumps({'id':request_id}))
        temporary = root / 'request.tmp'
        temporary.write_text(json.dumps(request)); temporary.replace(root / 'request.json')
    result = root / (request_id + '.json')
    until = time.monotonic() + 30
    while not result.exists():
        if time.monotonic() >= until:
            raise SystemExit('Result unknown. Use recover; do not resend')
        time.sleep(0.1)
    response = json.loads(result.read_text())
    if response.get('id') != request_id or response.get('session') != session:
        raise SystemExit('Response mismatch')
    # Native recovers this same immutable snapshot; never print image payloads or credentials.
    if response.get('ok') and 'bundle' in response.get('value', {}):
        temporary = root / 'snapshot.tmp'; temporary.write_text(json.dumps(response)); temporary.replace(root / 'snapshot.json')
        response['value'] = {'state':response['value']['state'], 'saved_snapshot':True}
    pending.unlink()
    print(json.dumps(response, ensure_ascii=False))
