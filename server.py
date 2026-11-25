import json
import logging
import os
import queue
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request, send_from_directory
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger("chest-counter")

BASE_DIR = Path(__file__).resolve().parent
DOCS_DIR = BASE_DIR / "docs"
DATA_DIR = BASE_DIR / "data"
DATA_FILE = DATA_DIR / "chest_data.json"
ANALYZER_DLL = BASE_DIR / "analyzer" / "bin" / "Release" / "net10.0" / "ReplayChestAnalyzer.dll"
DOTNET_EXE = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "dotnet" / "dotnet.exe"
DEMOS_DIR = Path(os.environ.get("LOCALAPPDATA", "")) / "FortniteGame" / "Saved" / "Demos"
SERVER_HOST = "127.0.0.1"
SERVER_PORT = 5050

DEFAULT_DATA: dict[str, Any] = {
    "baseCount": 0,
    "currentManualMatch": 0,
    "countMode": "mine",
    "ignoredFiles": [],
    "matches": []
}

state_lock = threading.Lock()
status_lock = threading.Lock()
replay_queue: queue.Queue[str] = queue.Queue()
queued_paths: set[str] = set()

watcher_status: dict[str, Any] = {
    "demosExists": DEMOS_DIR.exists(),
    "demosPath": str(DEMOS_DIR),
    "analyzerReady": ANALYZER_DLL.exists() and DOTNET_EXE.exists(),
    "state": "idle",
    "message": "Listo y vigilando la carpeta Demos.",
    "activeFile": None,
    "lastUpdated": None
}


def set_watcher_status(state_name: str, message: str, active_file: str | None = None) -> None:
    with status_lock:
        watcher_status["demosExists"] = DEMOS_DIR.exists()
        watcher_status["analyzerReady"] = ANALYZER_DLL.exists() and DOTNET_EXE.exists()
        watcher_status["state"] = state_name
        watcher_status["message"] = message
        watcher_status["activeFile"] = active_file
        watcher_status["lastUpdated"] = datetime.now(timezone.utc).isoformat()


def to_non_negative_int(value: Any, fallback: int = 0) -> int:
    try:
        parsed = int(value)
        return parsed if parsed >= 0 else fallback
    except (TypeError, ValueError):
        return fallback


def sanitize_store(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {**DEFAULT_DATA, "ignoredFiles": [], "matches": []}

    count_mode = raw.get("countMode")
    if count_mode not in ("mine", "squad"):
        count_mode = "mine"

    ignored = [str(x) for x in raw.get("ignoredFiles", []) if isinstance(x, str) and x]
    matches: list[dict[str, Any]] = []
    for item in raw.get("matches", []):
        if not isinstance(item, dict):
            continue
        my_opened = to_non_negative_int(item.get("myOpened", item.get("chests", 0)))
        my_broken = to_non_negative_int(item.get("myBroken", 0))
        my_total = to_non_negative_int(item.get("myTotal", my_opened + my_broken))
        squad_opened = to_non_negative_int(item.get("squadOpened", my_opened))
        squad_broken = to_non_negative_int(item.get("squadBroken", my_broken))
        squad_total = to_non_negative_int(item.get("squadTotal", max(my_total, squad_opened + squad_broken)))

        matches.append({
            "id": str(item.get("id") or uuid.uuid4()),
            "source": "replay" if item.get("source") == "replay" else "manual",
            "fileName": item.get("fileName") if isinstance(item.get("fileName"), str) else None,
            "savedAt": item.get("savedAt") if isinstance(item.get("savedAt"), str) else datetime.now(timezone.utc).isoformat(),
            "lengthMs": to_non_negative_int(item.get("lengthMs", 0)),
            "myOpened": my_opened,
            "myBroken": my_broken,
            "myTotal": my_total,
            "squadOpened": squad_opened,
            "squadBroken": squad_broken,
            "squadTotal": squad_total
        })

    return {
        "baseCount": to_non_negative_int(raw.get("baseCount", 0)),
        "currentManualMatch": to_non_negative_int(raw.get("currentManualMatch", 0)),
        "countMode": count_mode,
        "ignoredFiles": ignored,
        "matches": matches
    }


def load_store() -> dict[str, Any]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not DATA_FILE.exists():
        return sanitize_store(DEFAULT_DATA)
    try:
        with DATA_FILE.open("r", encoding="utf-8") as fh:
            return sanitize_store(json.load(fh))
    except (OSError, json.JSONDecodeError) as exc:
        logger.error("No se pudo leer %s: %s", DATA_FILE, exc)
        return sanitize_store(DEFAULT_DATA)


def save_store(store: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp_file = DATA_DIR / f"chest_data.{uuid.uuid4().hex}.tmp"
    with tmp_file.open("w", encoding="utf-8") as fh:
        json.dump(store, fh, indent=2, ensure_ascii=False)
    os.replace(tmp_file, DATA_FILE)


def is_file_ready(path: Path) -> bool:
    if not path.exists() or not path.is_file() or path.stat().st_size == 0:
        return False
    try:
        with path.open("rb") as fh:
            fh.read(16)
        return True
    except OSError:
        return False


def analyze_replay_file(replay_path: Path) -> dict[str, Any]:
    if not DOTNET_EXE.exists() or not ANALYZER_DLL.exists():
        raise RuntimeError("No se encontró dotnet.exe o ReplayChestAnalyzer.dll compilado.")

    proc = subprocess.run(
        [str(DOTNET_EXE), str(ANALYZER_DLL), str(replay_path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "Error desconocido").strip()
        raise RuntimeError(err)

    return json.loads(proc.stdout.strip())


def enqueue_replay(path: Path) -> None:
    if path.suffix.lower() != ".replay":
        return
    resolved = str(path.resolve())
    with state_lock:
        if resolved in queued_paths:
            return
        queued_paths.add(resolved)
    replay_queue.put(resolved)


def scan_existing_replays(include_ignored: bool = False) -> int:
    if not DEMOS_DIR.exists():
        set_watcher_status("warning", f"No existe la carpeta Demos en {DEMOS_DIR}.")
        return 0

    with state_lock:
        store = load_store()
        known_files = {m["fileName"] for m in store["matches"] if m.get("fileName")}
        if include_ignored:
            store["ignoredFiles"] = []
            save_store(store)
        ignored_files = set(store["ignoredFiles"])

    replays = sorted(DEMOS_DIR.glob("*.replay"), key=lambda p: p.stat().st_mtime, reverse=True)
    enqueued = 0
    for replay in replays:
        if replay.name in known_files or replay.name in ignored_files:
            continue
        enqueue_replay(replay)
        enqueued += 1

    if enqueued == 0:
        set_watcher_status("idle", "Todo al día. Esperando nuevas partidas en Demos.")
    return enqueued


def replay_worker_loop() -> None:
    deferred: dict[str, float] = {}

    while True:
        now = time.monotonic()
        ready_deferred = [p for p, retry_at in deferred.items() if retry_at <= now]
        for p in ready_deferred:
            deferred.pop(p, None)
            replay_queue.put(p)

        try:
            path_str = replay_queue.get(timeout=2.0)
        except queue.Empty:
            continue

        replay_path = Path(path_str)
        try:
            with state_lock:
                store = load_store()
                known_files = {m["fileName"] for m in store["matches"] if m.get("fileName")}
                ignored_files = set(store["ignoredFiles"])

            if replay_path.name in known_files or replay_path.name in ignored_files:
                continue

            if not is_file_ready(replay_path):
                # Fortnite mantiene bloqueado el .replay mientras la partida sigue en curso
                deferred[path_str] = time.monotonic() + 5.0
                set_watcher_status(
                    "in_match",
                    f"Partida en curso detectada ({replay_path.name}). Se analizará al volver al lobby.",
                    replay_path.name
                )
                continue

            pending = replay_queue.qsize()
            suffix = f" (faltan {pending})" if pending > 0 else ""
            set_watcher_status("analyzing", f"Analizando {replay_path.name}{suffix}...", replay_path.name)
            analysis = analyze_replay_file(replay_path)

            match_entry = {
                "id": f"r-{uuid.uuid4().hex[:10]}",
                "source": "replay",
                "fileName": replay_path.name,
                "savedAt": analysis.get("timestamp") or datetime.now(timezone.utc).isoformat(),
                "lengthMs": to_non_negative_int(analysis.get("lengthMs", 0)),
                "myOpened": to_non_negative_int(analysis.get("myOpened", 0)),
                "myBroken": to_non_negative_int(analysis.get("myBroken", 0)),
                "myTotal": to_non_negative_int(analysis.get("myTotal", 0)),
                "squadOpened": to_non_negative_int(analysis.get("squadOpened", 0)),
                "squadBroken": to_non_negative_int(analysis.get("squadBroken", 0)),
                "squadTotal": to_non_negative_int(analysis.get("squadTotal", 0))
            }

            with state_lock:
                store = load_store()
                if not any(m.get("fileName") == replay_path.name for m in store["matches"]):
                    store["matches"].append(match_entry)
                    store["matches"].sort(key=lambda m: m.get("savedAt", ""))
                    save_store(store)

            logger.info(
                "Partida %s analizada: míos=%s (%s abiertos, %s rotos) | escuadrón=%s",
                replay_path.name,
                match_entry["myTotal"],
                match_entry["myOpened"],
                match_entry["myBroken"],
                match_entry["squadTotal"]
            )
            set_watcher_status(
                "idle",
                f"Última partida leída: +{match_entry['myTotal']} cofres tuyos ({match_entry['myOpened']} abiertos, {match_entry['myBroken']} rotos)."
            )
        except Exception as exc:
            err_msg = str(exc)
            if "being used by another process" in err_msg:
                deferred[path_str] = time.monotonic() + 5.0
                set_watcher_status(
                    "in_match",
                    f"Partida en curso ({replay_path.name}). Se sumará automáticamente al terminar.",
                    replay_path.name
                )
                continue

            logger.error("Error procesando %s: %s", replay_path.name, exc)
            set_watcher_status("error", f"No se pudo leer {replay_path.name}: {err_msg}")
        finally:
            if path_str not in deferred:
                with state_lock:
                    queued_paths.discard(path_str)
            replay_queue.task_done()


class DemosEventHandler(FileSystemEventHandler):
    def on_created(self, event) -> None:
        if not event.is_directory:
            enqueue_replay(Path(event.src_path))

    def on_modified(self, event) -> None:
        if not event.is_directory:
            enqueue_replay(Path(event.src_path))

    def on_moved(self, event) -> None:
        if not event.is_directory:
            enqueue_replay(Path(event.dest_path))


app = Flask(__name__, static_folder=str(DOCS_DIR), static_url_path="")


@app.get("/")
def serve_index():
    return send_from_directory(DOCS_DIR, "index.html")


@app.get("/api/state")
def api_get_state():
    with state_lock:
        store = load_store()
    with status_lock:
        status = dict(watcher_status)
    return jsonify({"store": store, "watcher": status})


@app.post("/api/scan")
def api_scan():
    body = request.get_json(silent=True) or {}
    include_ignored = bool(body.get("includeIgnored", False))
    enqueued = scan_existing_replays(include_ignored=include_ignored)
    return jsonify({"enqueued": enqueued})


@app.post("/api/settings")
def api_update_settings():
    body = request.get_json(silent=True) or {}
    with state_lock:
        store = load_store()
        if "baseCount" in body:
            store["baseCount"] = to_non_negative_int(body["baseCount"], store["baseCount"])
        if "currentManualMatch" in body:
            store["currentManualMatch"] = to_non_negative_int(body["currentManualMatch"], store["currentManualMatch"])
        if body.get("countMode") in ("mine", "squad"):
            store["countMode"] = body["countMode"]
        save_store(store)
        return jsonify({"store": store})


@app.post("/api/matches/manual")
def api_add_manual_match():
    body = request.get_json(silent=True) or {}
    chests = to_non_negative_int(body.get("chests"), -1)
    if chests <= 0:
        return jsonify({"error": "La cantidad de cofres debe ser mayor a 0."}), 400

    entry = {
        "id": f"m-{uuid.uuid4().hex[:10]}",
        "source": "manual",
        "fileName": None,
        "savedAt": datetime.now(timezone.utc).isoformat(),
        "lengthMs": 0,
        "myOpened": chests,
        "myBroken": 0,
        "myTotal": chests,
        "squadOpened": chests,
        "squadBroken": 0,
        "squadTotal": chests
    }
    with state_lock:
        store = load_store()
        store["matches"].append(entry)
        store["currentManualMatch"] = 0
        save_store(store)
        return jsonify({"store": store, "added": entry})


@app.delete("/api/matches/<match_id>")
def api_delete_match(match_id: str):
    with state_lock:
        store = load_store()
        removed = next((m for m in store["matches"] if m["id"] == match_id), None)
        if not removed:
            return jsonify({"error": "Partida no encontrada."}), 404
        store["matches"] = [m for m in store["matches"] if m["id"] != match_id]
        if removed.get("fileName") and removed["fileName"] not in store["ignoredFiles"]:
            store["ignoredFiles"].append(removed["fileName"])
        save_store(store)
        return jsonify({"store": store})


@app.post("/api/reset")
def api_reset_all():
    with state_lock:
        store = load_store()
        ignored = list({
            *store["ignoredFiles"],
            *(m["fileName"] for m in store["matches"] if m.get("fileName"))
        })
        fresh = {**DEFAULT_DATA, "ignoredFiles": ignored, "matches": []}
        save_store(fresh)
        return jsonify({"store": fresh})


@app.post("/api/import")
def api_import_backup():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "Formato JSON inválido."}), 400
    sanitized = sanitize_store(body)
    with state_lock:
        save_store(sanitized)
        return jsonify({"store": sanitized})


def start_background_services() -> Observer | None:
    worker = threading.Thread(target=replay_worker_loop, daemon=True)
    worker.start()

    scan_existing_replays(include_ignored=False)

    if DEMOS_DIR.exists():
        observer = Observer()
        observer.schedule(DemosEventHandler(), str(DEMOS_DIR), recursive=False)
        observer.start()
        return observer

    set_watcher_status("warning", f"No se encontró la carpeta Demos ({DEMOS_DIR}).")
    return None


if __name__ == "__main__":
    obs = start_background_services()
    try:
        logger.info("Servidor iniciado en http://%s:%s", SERVER_HOST, SERVER_PORT)
        app.run(host=SERVER_HOST, port=SERVER_PORT, debug=False, use_reloader=False)
    finally:
        if obs is not None:
            obs.stop()
            obs.join(timeout=3)
