"""Offline classification entry point. Task text arrives on stdin and is never persisted."""
import errno
import json
import math
import os
from pathlib import Path
import sys
import socket
import time

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None
    import msvcrt

_STARTED = time.monotonic()

os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", TOKENIZERS_PARALLELISM="false")

def deny_connection(*args, **kwargs):
    raise RuntimeError("Network disabled during local classification")


socket.socket.connect = deny_connection
socket.socket.connect_ex = deny_connection
socket.create_connection = deny_connection
# -I excludes the caller's working directory; only the bundled, versioned source is added.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from taskshape.relevance import should_read_file
from taskshape.context_selection import select_context
from taskshape.router import LayaBackend, questions_for, state_for, validate_answer


# Seconds to wait for another local inference before giving up (the hook then falls back); the request may override.
DEFAULT_LOCK_TIMEOUT = {"classify": 8.0, "should_read_file": 8.0, "select_context": 15.0}
# Total wall-clock budget for select_context, measured from process start; stays under the 60 s hook timeout.
DEFAULT_SELECT_CONTEXT_BUDGET = 45.0
EX_TEMPFAIL = 75


class InferenceBusy(Exception):
    pass


def _seconds(request, key, default):
    value = request.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return default
    return float(value)


def _lock_file_path():
    # Same base directory as plugins/shared/runtime.ts (TASKSHAPE_HOME override, else ~/.taskshape).
    return Path(os.environ.get("TASKSHAPE_HOME") or Path.home() / ".taskshape") / "inference.lock"


# What a held lock reports (msvcrt LK_NBLCK: EACCES/EDEADLK). Anything else, such as ENOLCK or EOPNOTSUPP on a
# filesystem without lock support, means locking is unavailable, so inference proceeds unserialized.
_BUSY_ERRNOS = {errno.EACCES, errno.EAGAIN, errno.EWOULDBLOCK, errno.EDEADLK}


def _try_lock(handle):
    try:
        if fcntl:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        else:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        return True
    except OSError as exc:
        return exc.errno not in _BUSY_ERRNOS


_lock_handle = None


def acquire_inference_lock(timeout):
    """Serialize local inference across processes; the OS releases the lock when this process exits."""
    global _lock_handle
    try:
        path = _lock_file_path()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        handle = open(path, "a+b")
    except (OSError, RuntimeError):
        return  # An unwritable lock location must not disable local classification.
    deadline = time.monotonic() + timeout
    while not _try_lock(handle):
        if time.monotonic() >= deadline:
            handle.close()
            raise InferenceBusy()
        time.sleep(0.05)
    _lock_handle = handle


def main():
    # The caller always sends UTF-8; do not depend on the process locale (cp1252 on Windows). Output is ASCII-escaped JSON.
    request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    operation = request.get("operation", "classify")
    if operation in DEFAULT_LOCK_TIMEOUT:
        acquire_inference_lock(_seconds(request, "lock_timeout", DEFAULT_LOCK_TIMEOUT[operation]))
    if operation == "select_context":
        try:
            backend = LayaBackend(sys.argv[1], device="cpu", threads=2)
        except (ImportError, ValueError, OSError, RuntimeError, FileNotFoundError):
            backend = None
        options = {key: request[key] for key in ("skip_threshold", "max_file_bytes", "chunk_lines", "max_chunks", "batch_size")
                   if key in request}
        # Lock wait and model load count against the budget.
        budget = _seconds(request, "time_budget", DEFAULT_SELECT_CONTEXT_BUDGET) - (time.monotonic() - _STARTED)
        json.dump(select_context(request.get("task"), request.get("paths"),
                                 root=request.get("root", "."), backend=backend,
                                 head_max_len=320, time_budget=max(0.0, budget), **options), sys.stdout)
        return
    if operation == "should_read_file":
        task, path = request.get("task"), request.get("path")
        summary, excerpt = request.get("summary", ""), request.get("excerpt", "")
        if not all(isinstance(value, str) for value in (task, path, summary, excerpt)):
            raise ValueError("Invalid relevance input")
        try:
            backend = LayaBackend(sys.argv[1], device="cpu", threads=2)
        except (ImportError, ValueError, OSError, RuntimeError, FileNotFoundError):
            backend = None
        json.dump(should_read_file(task, path, summary, excerpt, backend=backend, head_max_len=320), sys.stdout)
        return
    if operation != "classify":
        raise ValueError("Invalid runtime operation")
    task, phase = request.get("task"), request.get("phase", "work")
    if not isinstance(task, str) or phase not in ("work", "review"):
        raise ValueError("Invalid classification input")
    backend = LayaBackend(sys.argv[1], device="cpu", threads=2)
    questions = questions_for(phase)
    answer = validate_answer(backend.predict(state_for(task, phase), questions, 320)["answers"]["shape"], list(questions["shape"]["criteria"]))
    json.dump({"shape": answer["choice"], "answer_confidence": answer["answer_confidence"],
               "shape_probabilities": answer["probabilities"], "source": "laya"}, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except InferenceBusy:
        sys.stderr.write("Local Laya inference is busy.\n")
        sys.exit(EX_TEMPFAIL)
    except Exception:
        # Exceptions from external libraries can contain input; keep stderr free of task text.
        sys.stderr.write("Local Laya inference failed.\n")
        sys.exit(1)
