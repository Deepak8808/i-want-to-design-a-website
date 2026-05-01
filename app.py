from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import json
import mimetypes
import os
import queue
import re
import threading
import time
import uuid


ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
UPLOAD_DIR = ROOT / "uploads"
PORT = int(os.environ.get("PORT", "3000"))
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
ALLOWED_AUDIO_EXTENSIONS = {".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".webm"}

rooms = {}
rooms_lock = threading.Lock()


def room_template(room_id):
    return {
        "clients": {},
        "state": {
            "roomId": room_id,
            "title": "Untitled song",
            "sourceName": "",
            "sourceUrl": "",
            "mediaType": "audio",
            "youtubeId": "",
            "youtubeMode": "video",
            "isPlaying": False,
            "position": 0,
            "updatedAt": int(time.time() * 1000),
            "hostId": "",
        },
        "messages": [],
    }


def get_room(room_id):
    with rooms_lock:
        if room_id not in rooms:
            rooms[room_id] = room_template(room_id)
        return rooms[room_id]


def sse_payload(event_name, payload):
    data = json.dumps(payload, separators=(",", ":"))
    return f"event: {event_name}\ndata: {data}\n\n".encode("utf-8")


def broadcast(room_id, event_name, payload):
    room = get_room(room_id)
    packet = sse_payload(event_name, payload)
    dead_clients = []

    with rooms_lock:
        clients = list(room["clients"].items())

    for client_id, client_queue in clients:
        try:
            client_queue.put_nowait(packet)
        except Exception:
            dead_clients.append(client_id)

    if dead_clients:
        with rooms_lock:
            for client_id in dead_clients:
                room["clients"].pop(client_id, None)


def clean_empty_room(room_id):
    def cleanup():
        time.sleep(60)
        with rooms_lock:
            room = rooms.get(room_id)
            if room and not room["clients"]:
                rooms.pop(room_id, None)

    threading.Thread(target=cleanup, daemon=True).start()


def safe_filename(filename):
    stem = Path(filename or "song").stem
    ext = Path(filename or "").suffix.lower()
    stem = re.sub(r"[^a-zA-Z0-9_-]+", "-", stem).strip("-")[:60] or "song"
    if ext not in ALLOWED_AUDIO_EXTENSIONS:
        ext = ".mp3"
    return f"{stem}-{uuid.uuid4().hex[:10]}{ext}"


class CoupleSyncHandler(BaseHTTPRequestHandler):
    server_version = "CoupleSyncPython/1.0"

    def log_message(self, format, *args):
        print("%s - - [%s] %s" % (self.address_string(), self.log_date_time_string(), format % args))

    def send_json(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > 1_000_000:
            raise ValueError("Payload too large")
        if length == 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw)

    def do_GET(self):
        parsed = urlparse(self.path)
        path_parts = [part for part in parsed.path.split("/") if part]

        if len(path_parts) == 4 and path_parts[:2] == ["api", "rooms"] and path_parts[3] == "events":
            self.handle_events(path_parts[2], parsed.query)
            return

        if path_parts[:1] == ["uploads"]:
            self.serve_upload(parsed.path)
            return

        self.serve_static(parsed.path)

    def do_POST(self):
        parsed = urlparse(self.path)
        path_parts = [part for part in parsed.path.split("/") if part]

        if parsed.path == "/api/room":
            room_id = str(uuid.uuid4()).split("-")[0].upper()
            get_room(room_id)
            self.send_json(201, {"roomId": room_id})
            return

        if len(path_parts) == 4 and path_parts[:2] == ["api", "rooms"]:
            try:
                if path_parts[3] == "upload":
                    self.handle_upload(path_parts[2])
                    return
                self.handle_room_action(path_parts[2], path_parts[3])
            except Exception as error:
                self.send_json(400, {"error": str(error)})
            return

        self.send_json(404, {"error": "Not found"})

    def handle_upload(self, room_id):
        content_type = self.headers.get("Content-Type", "")
        match = re.search(r"boundary=([^;]+)", content_type)
        if "multipart/form-data" not in content_type or not match:
            self.send_json(400, {"error": "Expected multipart upload"})
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0 or length > MAX_UPLOAD_BYTES:
            self.send_json(400, {"error": "Audio file must be under 100 MB"})
            return

        boundary = ("--" + match.group(1).strip('"')).encode("utf-8")
        body = self.rfile.read(length)
        file_bytes = None
        original_name = "song.mp3"
        client_id = ""

        for part in body.split(boundary):
            if b"Content-Disposition:" not in part:
                continue
            header_end = part.find(b"\r\n\r\n")
            if header_end == -1:
                continue
            headers = part[:header_end].decode("utf-8", errors="ignore")
            content = part[header_end + 4:]
            if content.endswith(b"\r\n"):
                content = content[:-2]
            if content.endswith(b"--"):
                content = content[:-2]

            if 'name="clientId"' in headers:
                client_id = content.decode("utf-8", errors="ignore")[:80]
                continue

            if 'name="song"' not in headers:
                continue

            filename_match = re.search(r'filename="([^"]*)"', headers)
            if filename_match:
                original_name = filename_match.group(1)
            file_bytes = content

        if not file_bytes:
            self.send_json(400, {"error": "No audio file received"})
            return

        filename = safe_filename(original_name)
        room_upload_dir = UPLOAD_DIR / room_id
        room_upload_dir.mkdir(parents=True, exist_ok=True)
        file_path = room_upload_dir / filename
        file_path.write_bytes(file_bytes)

        source_url = f"/uploads/{room_id}/{filename}"
        title = Path(original_name).stem or "Shared song"
        room = get_room(room_id)
        with rooms_lock:
            next_state = {
                **room["state"],
                "title": title[:120],
                "sourceName": original_name[:180],
                "sourceUrl": source_url,
                "mediaType": "audio",
                "youtubeId": "",
                "youtubeMode": "video",
                "isPlaying": False,
                "position": 0,
                "updatedAt": int(time.time() * 1000),
                "hostId": client_id,
            }
            room["state"] = next_state

        broadcast(room_id, "state", next_state)
        self.send_json(200, {
            "title": next_state["title"],
            "sourceName": next_state["sourceName"],
            "sourceUrl": source_url,
            "state": next_state,
        })

    def handle_events(self, room_id, query_string):
        query = parse_qs(query_string)
        client_id = query.get("clientId", [str(uuid.uuid4())])[0]
        room = get_room(room_id)
        client_queue = queue.Queue()

        with rooms_lock:
            room["clients"][client_id] = client_queue
            count = len(room["clients"])
            hello_state = room["state"]
            hello_messages = room["messages"][-30:]

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        try:
            self.wfile.write(sse_payload("hello", {
                "clientId": client_id,
                "state": hello_state,
                "messages": hello_messages,
            }))
            self.wfile.flush()
            broadcast(room_id, "presence", {"count": count})

            while True:
                try:
                    packet = client_queue.get(timeout=10)
                    self.wfile.write(packet)
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        finally:
            with rooms_lock:
                room["clients"].pop(client_id, None)
                count = len(room["clients"])
            broadcast(room_id, "presence", {"count": count})
            clean_empty_room(room_id)

    def handle_room_action(self, room_id, action):
        body = self.read_json()
        room = get_room(room_id)

        if action == "state":
            with rooms_lock:
                previous = room["state"]
                next_state = {
                    **previous,
                    "title": str(body.get("title") or previous.get("title") or "Untitled song")[:120],
                    "sourceName": str(body.get("sourceName") or previous.get("sourceName") or "")[:180],
                    "sourceUrl": str(body.get("sourceUrl") or previous.get("sourceUrl") or "")[:2000],
                    "mediaType": str(body.get("mediaType") or previous.get("mediaType") or "audio")[:20],
                    "youtubeId": str(body.get("youtubeId") or previous.get("youtubeId") or "")[:40],
                    "youtubeMode": str(body.get("youtubeMode") or previous.get("youtubeMode") or "video")[:20],
                    "isPlaying": bool(body.get("isPlaying")),
                    "position": max(0, float(body.get("position") or 0)),
                    "updatedAt": int(time.time() * 1000),
                    "hostId": str(body.get("clientId") or previous.get("hostId") or "")[:80],
                }
                room["state"] = next_state

            broadcast(room_id, "state", next_state)
            self.send_json(200, next_state)
            return

        if action == "message":
            message = {
                "id": str(uuid.uuid4()),
                "sender": str(body.get("sender") or "Guest")[:30],
                "text": str(body.get("text") or "")[:240],
                "kind": str(body.get("kind") or "chat")[:20],
                "mood": str(body.get("mood") or "")[:30],
                "sentAt": int(time.time() * 1000),
            }
            if message["text"].strip():
                with rooms_lock:
                    room["messages"].append(message)
                    room["messages"] = room["messages"][-50:]
                broadcast(room_id, "message", message)

            self.send_json(200, message)
            return

        self.send_json(404, {"error": "Unknown room action"})

    def serve_file(self, file_path, content_type=None):
        size = file_path.stat().st_size
        range_header = self.headers.get("Range", "")
        content_type = content_type or mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"

        if range_header.startswith("bytes="):
            start_text, _, end_text = range_header.replace("bytes=", "", 1).partition("-")
            start = int(start_text or "0")
            end = int(end_text) if end_text else size - 1
            start = max(0, min(start, size - 1))
            end = max(start, min(end, size - 1))
            length = end - start + 1

            self.send_response(206)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(length))
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            with file_path.open("rb") as file:
                file.seek(start)
                self.wfile.write(file.read(length))
            return

        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def serve_upload(self, requested_path):
        requested = requested_path.lstrip("/")
        file_path = (ROOT / requested).resolve()

        try:
            file_path.relative_to(UPLOAD_DIR.resolve())
        except ValueError:
            self.send_error(403, "Forbidden")
            return

        if not file_path.is_file():
            self.send_error(404, "Not found")
            return

        self.serve_file(file_path)

    def serve_static(self, requested_path):
        if requested_path == "/":
            requested_path = "/index.html"

        requested = requested_path.lstrip("/")
        file_path = (PUBLIC_DIR / requested).resolve()

        try:
            file_path.relative_to(PUBLIC_DIR.resolve())
        except ValueError:
            self.send_error(403, "Forbidden")
            return

        if not file_path.is_file():
            self.send_error(404, "Not found")
            return

        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        self.serve_file(file_path, content_type)


def main():
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), CoupleSyncHandler)
    server.daemon_threads = True
    print(f"Couple Sync Listen is running at http://localhost:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
