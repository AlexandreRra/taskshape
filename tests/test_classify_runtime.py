"""Exercise runtime/classify.py as the plugins launch it: isolated, locale-independent, serialized."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None
    import msvcrt

ROOT = Path(__file__).resolve().parent.parent
CLASSIFY = ROOT / "runtime" / "classify.py"


def hold_lock(handle):
    """Take the inference lock the way classify.py does, on either platform; raises OSError if it is busy."""
    if fcntl:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    else:
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)


def release_lock(handle):
    if fcntl:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    else:
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


class ClassifyRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.home = self.root / "home"

    def run_classify(self, request, extra_args=(), env=None, timeout=30):
        environment = {**os.environ, "TASKSHAPE_HOME": str(self.home), **(env or {})}
        return subprocess.run([sys.executable, *extra_args, "-I", str(CLASSIFY), str(self.root / "no-checkpoint")],
                              input=json.dumps(request, ensure_ascii=False).encode("utf-8"),
                              capture_output=True, timeout=timeout, env=environment)

    def test_stdin_is_utf8_even_when_the_locale_is_not(self):
        name = "\u00c1rea de login.py"  # need not exist: the requested path is echoed back unchanged
        request = {"operation": "select_context", "task": "\u00c1rea de login: corrigir \u00cdndice",
                   "paths": [name], "root": str(self.root)}

        result = self.run_classify(request, extra_args=("-X", "utf8=0"), env={"LC_ALL": "C", "LANG": "C"})

        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout.decode("ascii"))  # ASCII-escaped, so no locale-dependent output encoding
        self.assertEqual(output["files"][0]["path"], name)

    def test_invalid_utf8_input_fails_without_echoing_it(self):
        result = subprocess.run([sys.executable, "-I", str(CLASSIFY), str(self.root / "no-checkpoint")],
                                input=b'{"task": "\xff\xfe"}', capture_output=True, timeout=30,
                                env={**os.environ, "TASKSHAPE_HOME": str(self.home)})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, b"Local Laya inference failed.\n")

    def test_inference_waits_for_the_lock_then_gives_up_with_a_controlled_error(self):
        self.home.mkdir()
        request = {"operation": "should_read_file", "task": "Fix login", "path": "a.py", "lock_timeout": 0.3}
        with open(self.home / "inference.lock", "a+b") as held:
            hold_lock(held)
            started = time.monotonic()
            busy = self.run_classify(request)
            waited = time.monotonic() - started
            release_lock(held)

        self.assertEqual(busy.returncode, 75)
        self.assertEqual(busy.stdout, b"")
        self.assertEqual(busy.stderr, b"Local Laya inference is busy.\n")
        self.assertGreaterEqual(waited, 0.3)

        free = self.run_classify(request)  # the lock was released, so the fallback decision is produced
        self.assertEqual(free.returncode, 0, free.stderr)
        self.assertTrue(json.loads(free.stdout)["should_read"])

    def test_a_waiting_process_proceeds_once_the_lock_is_released(self):
        self.home.mkdir()
        request = {"operation": "select_context", "task": "Fix", "paths": ["missing.py"], "root": str(self.root),
                   "lock_timeout": 20}
        held = open(self.home / "inference.lock", "a+b")
        self.addCleanup(held.close)
        hold_lock(held)
        waiting = subprocess.Popen([sys.executable, "-I", str(CLASSIFY), str(self.root / "no-checkpoint")],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env={**os.environ, "TASKSHAPE_HOME": str(self.home)})
        self.addCleanup(waiting.kill)
        waiting.stdin.write(json.dumps(request).encode("utf-8"))
        waiting.stdin.close()
        time.sleep(0.5)
        self.assertIsNone(waiting.poll())  # still blocked on the lock

        release_lock(held)
        stdout = waiting.stdout.read()
        waiting.wait(timeout=20)
        waiting.stdout.close()
        waiting.stderr.close()

        self.assertEqual(waiting.returncode, 0)
        self.assertTrue(json.loads(stdout)["files"][0]["should_read"])

    def test_an_unwritable_lock_location_does_not_block_classification(self):
        blocker = self.root / "not-a-directory"
        blocker.write_text("file")
        request = {"operation": "select_context", "task": "Fix", "paths": ["missing.py"], "root": str(self.root)}

        result = self.run_classify(request, env={"TASKSHAPE_HOME": str(blocker / "home")})

        self.assertEqual(result.returncode, 0, result.stderr)

    def run_with_fake_backend(self, request, predict_batch_body):
        """Run classify.py as __main__ with the real Laya backend replaced by a fake one."""
        driver = (
            "import runpy, sys\n"
            "sys.path.insert(0, %r)\n"
            "import taskshape.router as router\n"
            "class Fake:\n"
            "    name = 'fake'\n"
            "    def __init__(self, *a, **k): pass\n"
            "    def state_usage(self, *a, **k): return {'truncated': False, 'state_tokens_dropped': 0}\n"
            "    def predict_batch(self, states, *a, **k): %s\n"
            "router.LayaBackend = Fake\n"
            "sys.argv = [%r, 'checkpoint']\n"
            "runpy.run_path(%r, run_name='__main__')\n"
        ) % (str(ROOT / "runtime"), predict_batch_body, str(CLASSIFY), str(CLASSIFY))
        return subprocess.run([sys.executable, "-I", "-c", driver], input=json.dumps(request).encode("utf-8"),
                              capture_output=True, timeout=30, env={**os.environ, "TASKSHAPE_HOME": str(self.home)})

    def test_filesystem_without_lock_support_proceeds_instead_of_waiting(self):
        driver = (
            "import errno, runpy, sys\n"
            "def unsupported(*a, **k): raise OSError(errno.ENOLCK, 'no locks available')\n"
            "try:\n"
            "    import fcntl\n"
            "    fcntl.flock = unsupported\n"
            "except ImportError:\n"
            "    import msvcrt\n"
            "    msvcrt.locking = unsupported\n"
            "sys.argv = [%r, 'checkpoint']\n"
            "runpy.run_path(%r, run_name='__main__')\n"
        ) % (str(CLASSIFY), str(CLASSIFY))
        request = {"operation": "should_read_file", "task": "Fix login", "path": "a.py", "lock_timeout": 20}

        started = time.monotonic()
        result = subprocess.run([sys.executable, "-I", "-c", driver], input=json.dumps(request).encode("utf-8"),
                                capture_output=True, timeout=30, env={**os.environ, "TASKSHAPE_HOME": str(self.home)})

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(time.monotonic() - started, 10)  # no wait for the 20 s lock timeout
        self.assertTrue(json.loads(result.stdout)["should_read"])

    def test_select_context_time_budget_is_forwarded(self):
        (self.root / "a.txt").write_text("a\nb\n")
        request = {"operation": "select_context", "task": "Fix", "paths": ["a.txt"], "root": str(self.root)}
        strong_no = ("return [{'answers': {'relevance': {'choice': 'no', 'probabilities': {'yes': 0.01, 'no': 0.99}, "
                     "'answer_confidence': 0.99, 'confidence': 0.5}}, "
                     "'usage': {'truncated': False, 'state_tokens_dropped': 0}} for _ in states]")

        in_time = self.run_with_fake_backend({**request, "time_budget": 30}, strong_no)
        out_of_time = self.run_with_fake_backend({**request, "time_budget": 0},
                                                 "raise AssertionError('inference must not start')")

        self.assertEqual(in_time.returncode, 0, in_time.stderr)
        self.assertEqual(out_of_time.returncode, 0, out_of_time.stderr)
        self.assertTrue(json.loads(in_time.stdout)["complete"])
        self.assertFalse(json.loads(in_time.stdout)["files"][0]["should_read"])
        self.assertFalse(json.loads(out_of_time.stdout)["complete"])
        self.assertTrue(json.loads(out_of_time.stdout)["files"][0]["should_read"])


if __name__ == "__main__":
    unittest.main()
