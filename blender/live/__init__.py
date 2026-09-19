"""Local, authenticated MCP subset for the explicitly opened Blender GUI.
No remote services, telemetry, arbitrary Python, file loading or process exit.
"""
import bpy
from .observation import observe, fingerprint
from .operations import apply
import json
import secrets
import uuid
import queue
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from bpy.app.handlers import persistent

bl_info = {"name": "Manga Mac Live", "author": "Manga Mac contributors", "version": (1, 0, 0), "blender": (4, 5, 0), "category": "Interface"}
PROTOCOL = "2025-03-26"
SERVER = None
TOKEN = ""
INSTANCE = ""
EPOCH = ""
REVISION = 0
QUEUE = queue.Queue(maxsize=8)
CLIENT = None
CONTROL = "manual"
FINGERPRINT = None
REQUESTS = set()


def identity():
    global FINGERPRINT
    current = fingerprint()
    if current != FINGERPRINT:
        FINGERPRINT = current
        invalidate()
    c = bpy.context
    return {"instance": INSTANCE, "epoch": EPOCH, "revision": REVISION,
            "file": bpy.data.filepath, "scene": c.scene.name,
            "view_layer": c.view_layer.name,
            "camera": c.scene.camera.name if c.scene.camera else None,
            "mode": "live", "control": CONTROL, "telemetry": False}


@persistent
def invalidate(*_):
    global REVISION
    REVISION += 1


@persistent
def reload_epoch(*_):
    global EPOCH, CLIENT, CONTROL
    EPOCH = str(uuid.uuid4())
    CLIENT = None
    CONTROL = "manual"
    invalidate()


def tool_names():
    return ["live_identity", "live_claim", "live_release", "live_observe", "live_resume", "live_act"]


def invoke_tool(name, args):
    global CLIENT, CONTROL
    if name == "live_identity":
        return identity()
    if name == "live_claim":
        if args.get("instance") != INSTANCE or args.get("epoch") != EPOCH:
            raise ValueError("target_mismatch: Blender instance changed")
        client = args.get("client")
        if not isinstance(client, str) or len(client) < 16:
            raise ValueError("invalid client")
        if CLIENT and CLIENT != client:
            raise ValueError("another client owns this session")
        CLIENT = client
        CONTROL = "manual"
        return identity()
    if args.get("client") != CLIENT or CLIENT is None:
        raise ValueError("session mismatch: reconnect explicitly")
    if name in ("live_resume", "live_act"):
        current = identity()
        expected = args.get("expected", {})
        for key in ("instance", "epoch", "revision", "file", "scene", "view_layer"):
            if current[key] != expected.get(key):
                raise ValueError("stale_observation: observe again")
        if name == "live_resume":
            CONTROL = "ai"
            return identity()
        if CONTROL != "ai":
            raise ValueError("manual_control: automatic write disabled")
        request = args.get("request_id")
        if not isinstance(request, str) or len(request) != 36 or request in REQUESTS:
            raise ValueError("execution_unknown: request already submitted or invalid")
        if len(REQUESTS) >= 10000:
            raise ValueError("session request limit: restart explicitly")
        REQUESTS.add(request)
        result = apply(args.get("operation", {}))
        return {**result, **identity()}
    if name == "live_observe":
        before = identity()
        result = observe(args)
        after = identity()
        if before["epoch"] != after["epoch"]:
            raise ValueError("stale_observation")
        return {**result, **after}
    if name == "live_release":
        CLIENT = None
        CONTROL = "manual"
        return identity()
    raise ValueError("unsupported tool")


def dispatch(body):
    method = body.get("method")
    params = body.get("params", {})
    if method == "initialize":
        return {"protocolVersion": PROTOCOL, "capabilities": {"tools": {}},
                "serverInfo": {"name": "manga-mac-live", "version": "1.0.0"}}
    if method == "tools/list":
        return {"tools": [{"name": n, "description": n, "inputSchema": {"type": "object"}} for n in tool_names()]}
    if method == "tools/call":
        result = invoke_tool(params.get("name"), params.get("arguments", {}))
        return {"content": [{"type": "text", "text": json.dumps(result)}], "isError": False}
    if method == "ping":
        return {}
    raise ValueError("unsupported MCP method")


def pump():
    try:
        body, event, reply, expired = QUEUE.get_nowait()
    except queue.Empty:
        return .05
    if not expired.is_set():
        try:
            reply["result"] = dispatch(body)
        except Exception as exc:
            reply["error"] = {"code": -32000, "message": str(exc)}
    event.set()
    return .05


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Never log tokens, instructions or scene contents.

    def do_POST(self):
        if (self.path != "/mcp" or self.headers.get("Origin") is not None
                or self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}"
                or not secrets.compare_digest(self.headers.get("Authorization", ""), "Bearer " + TOKEN)):
            self.send_error(403)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 65536:
                raise ValueError("request too large")
            body = json.loads(self.rfile.read(length))
            if body.get("jsonrpc") != "2.0":
                raise ValueError("invalid JSON-RPC")
            if "id" not in body:
                if body.get("method") != "notifications/initialized":
                    raise ValueError("unsupported notification")
                self.send_response(202)
                self.end_headers()
                return
            event, expired, reply = threading.Event(), threading.Event(), {}
            QUEUE.put_nowait((body, event, reply, expired))
            if not event.wait(30):
                expired.set()
                raise ValueError("execution_unknown: reobserve, do not resend")
            response = {"jsonrpc": "2.0", "id": body["id"], **reply}
            raw = json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        except Exception:
            self.send_error(400, "MCP request failed; reobserve before another action")

    def setup(self):
        super().setup()
        self.connection.settimeout(35)


def stop():
    global SERVER, CLIENT, CONTROL, TOKEN
    if SERVER:
        SERVER.shutdown()
        SERVER.server_close()
    SERVER = None
    CLIENT = None
    CONTROL = "manual"
    TOKEN = ""
    if bpy.app.timers.is_registered(pump):
        bpy.app.timers.unregister(pump)


class LIVE_OT_start(bpy.types.Operator):
    bl_idname = "manga_live.start"
    bl_label = "Start local connection"

    def execute(self, context):
        global SERVER, TOKEN, INSTANCE, EPOCH
        if SERVER:
            return {'CANCELLED'}
        TOKEN = secrets.token_hex(32)
        INSTANCE, EPOCH = str(uuid.uuid4()), str(uuid.uuid4())
        try:
            SERVER = HTTPServer(("127.0.0.1", context.window_manager.manga_live_port), Handler)
        except OSError as exc:
            self.report({'ERROR'}, str(exc))
            return {'CANCELLED'}
        threading.Thread(target=SERVER.serve_forever, daemon=True).start()
        bpy.app.timers.register(pump, persistent=True)
        context.window_manager.manga_live_token = TOKEN
        context.window_manager.manga_live_instance = INSTANCE
        return {'FINISHED'}


class LIVE_OT_stop(bpy.types.Operator):
    bl_idname = "manga_live.stop"
    bl_label = "Disconnect local server"

    def execute(self, context):
        stop()
        context.window_manager.manga_live_token = ""
        return {'FINISHED'}


class LIVE_PT_panel(bpy.types.Panel):
    bl_label = "Manga Mac Live"
    bl_idname = "LIVE_PT_manga"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'Manga Live'

    def draw(self, context):
        layout = self.layout
        wm = context.window_manager
        if SERVER:
            layout.prop(wm, "manga_live_instance", text="Instance")
            layout.prop(wm, "manga_live_token", text="Token")
            layout.label(text="Local only / no telemetry")
            layout.operator("manga_live.stop")
        else:
            layout.prop(wm, "manga_live_port", text="Port")
            layout.operator("manga_live.start")


CLASSES = [LIVE_OT_start, LIVE_OT_stop, LIVE_PT_panel]
HANDLERS = [(bpy.app.handlers.depsgraph_update_post, invalidate),
            (bpy.app.handlers.frame_change_post, invalidate),
            (bpy.app.handlers.undo_post, reload_epoch), (bpy.app.handlers.redo_post, reload_epoch),
            (bpy.app.handlers.load_post, reload_epoch)]


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.WindowManager.manga_live_port = bpy.props.IntProperty(default=9877, min=1024, max=65535)
    bpy.types.WindowManager.manga_live_token = bpy.props.StringProperty(options={'SKIP_SAVE'})
    bpy.types.WindowManager.manga_live_instance = bpy.props.StringProperty(options={'SKIP_SAVE'})
    for handlers, fn in HANDLERS:
        handlers.append(fn)


def unregister():
    stop()
    for handlers, fn in HANDLERS:
        if fn in handlers:
            handlers.remove(fn)
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
    for name in ["manga_live_port", "manga_live_token", "manga_live_instance"]:
        delattr(bpy.types.WindowManager, name)
