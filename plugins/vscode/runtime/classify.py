"""Offline classification entry point. Task text arrives on stdin and is never persisted."""
import json
import os
from pathlib import Path
import sys
import socket

os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", TOKENIZERS_PARALLELISM="false")

def deny_connection(*args, **kwargs):
    raise RuntimeError("Network disabled during local classification")


socket.socket.connect = deny_connection
socket.socket.connect_ex = deny_connection
socket.create_connection = deny_connection
# -I excludes the caller's working directory; only the bundled, versioned source is added.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from taskshape.router import LayaBackend, questions_for, state_for, validate_answer


def main():
    request = json.load(sys.stdin)
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
    except Exception:
        # Exceptions from external libraries can contain input; keep stderr free of task text.
        sys.stderr.write("Local Laya inference failed.\n")
        sys.exit(1)
