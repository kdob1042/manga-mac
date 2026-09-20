"""Local, authenticated MCP subset for the explicitly opened Blender GUI.
No remote services, telemetry, arbitrary Python, file loading or process exit.
"""
import bpy
from .observation import observe, fingerprint
from .operations import apply
from .candidate import export_copy
import json
import secrets
import uuid
import queue
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
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
    return ["live_identity", "live_claim", "live_release", "live_observe", "live_resume", "live_act", "live_handoff", "live_candidate"]


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
        invalidate()
        return identity()
    if args.get("client") != CLIENT or CLIENT is None:
        raise ValueError("session mismatch: reconnect explicitly")
    if name == "live_handoff":
        CONTROL = "manual"
        invalidate()  # Invalidate every queued/unsent plan before handing control away.
        return identity()
    if name in ("live_resume", "live_act", "live_candidate"):
        current = identity()
        expected = args.get("expected", {})
        for key in ("instance", "epoch", "revision", "file", "scene", "view_layer"):
            if current[key] != expected.get(key):
                raise ValueError("stale_observation: observe again")
        if name == "live_candidate":
            if CONTROL != "manual":
                raise ValueError("handoff before candidate save")
            return {**export_copy(args), **identity()}
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
        invalidate()
        return identity()
    raise ValueError("unsupported tool")


def tool_schema(name):
    client = {"type": "string", "minLength": 16, "description": "Your random per-session client ID, reused until live_release"}
    expected = {"type": "object", "description": "Fresh observation identity; never reuse after a write or manual change",
                "properties": {k: {"type": "integer" if k == "revision" else "string"} for k in ("instance", "epoch", "revision", "file", "scene", "view_layer")},
                "required": ["instance", "epoch", "revision", "file", "scene", "view_layer"]}
    props, required = {"client": client}, ["client"]
    descriptions = {
        "live_identity": "Read GUI identity before claiming. Check instance/file/scene with the user; never switch files.",
        "live_claim": "Claim the explicitly selected GUI after manga-mac yields. Use a new random client ID. Fails if another client owns it.",
        "live_release": "Finish Codex operations and release ownership before returning to manga-mac.",
        "live_observe": "Read current GUI state. Summary first, then object detail or viewport/camera image. Images are distinct views.",
        "live_resume": "Enable this client's writes using a fresh observation. Stop mouse/keyboard editing first.",
        "live_act": "Apply camera lens, static object location, or constraint influence. Observe detail first, then read back. No arbitrary Python.",
        "live_handoff": "Disable automatic writes before manual editing or candidate save. This retains your client claim; release it to return to manga-mac.",
        "live_candidate": "Render and save a new copy in the same GUI, only after handoff. Prefer saving via manga-mac for candidate registration."}
    if name == "live_identity": props, required = {}, []
    if name == "live_claim":
        props.update({k:{"type":"string"} for k in ("instance","epoch")}); required += ["instance","epoch"]
    if name in ("live_resume","live_act","live_candidate"):
        props["expected"] = expected; required.append("expected")
    if name == "live_observe":
        props.update({"scope":{"type":"string","enum":["summary","object","viewport","camera"]},"object":{"type":"string"},"offset":{"type":"integer","minimum":0}})
    if name == "live_act":
        props.update({"request_id":{"type":"string","description":"Fresh UUID; never retry after an unknown result"},
            "operation":{"type":"object","properties":{"kind":{"enum":["camera","transform","constraint"]},"object":{"type":"string"},"object_id":{"type":"string"},"value":{"type":"number"},"constraint":{"type":"string"},"location":{"type":"array","items":{"type":"number"},"minItems":3,"maxItems":3}},"required":["kind","object","object_id"],"additionalProperties":False}})
        required += ["request_id","operation"]
    if name == "live_candidate": props.update({k:{"type":"integer","minimum":64,"maximum":4096} for k in ("width","height")})
    return {"name":name,"description":descriptions[name],"inputSchema":{"type":"object","properties":props,"required":required}}


def dispatch(body):
    method = body.get("method")
    params = body.get("params", {})
    if method == "initialize":
        return {"protocolVersion": PROTOCOL, "capabilities": {"tools": {}},
                "serverInfo": {"name": "manga-mac-live", "version": "1.0.0"}}
    if method == "tools/list":
        return {"tools": [tool_schema(n) for n in tool_names()]}
    if method == "tools/call":
        result = invoke_tool(params.get("name"), params.get("arguments", {}))
        return {"content": [{"type": "text", "text": json.dumps(result)}], "isError": False}
    if method == "ping":
        return {}
    raise ValueError("unsupported MCP method")


def pump():
    try:
        body, event, reply, expired, server = QUEUE.get_nowait()
    except queue.Empty:
        return .05
    if not expired.is_set():
        try:
            if server is not SERVER:
                raise ValueError("session ended; reconnect explicitly")
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
            QUEUE.put_nowait((body, event, reply, expired, self.server))
            if not event.wait(180):
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
        self.connection.settimeout(185)


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
            SERVER = ThreadingHTTPServer(("127.0.0.1", context.window_manager.manga_live_port), Handler)
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
