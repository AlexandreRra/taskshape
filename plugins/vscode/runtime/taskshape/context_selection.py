"""Local file context selection backed by conservative Laya relevance checks."""
from __future__ import annotations

from dataclasses import dataclass
import math
from pathlib import Path
import stat
import time
from typing import Any

from .relevance import _OPTIONS, _GENERIC_FALLBACK_WARNING, _usage_is_truncated, _valid_usage, relevance_questions
from .router import DEFAULT_HEAD_MAX_LEN, HeuristicBackend, validate_answer

DEFAULT_SKIP_THRESHOLD = 0.95
DEFAULT_MAX_FILE_BYTES = 256 * 1024
DEFAULT_CHUNK_LINES = 80
DEFAULT_MAX_CHUNKS = 64
DEFAULT_BATCH_SIZE = 8
FIRST_BATCH_CHUNKS = 2
# Stays below the 60 s hook timeout so a slow run returns partial results instead of being killed and discarded.
DEFAULT_TIME_BUDGET = 45.0
MAX_PATHS = 20
HUGE_LINE_CHARS = 20000
# Ceilings mirror plugins/shared/runtime.ts so CLI/MCP callers cannot request unbounded work.
MAX_FILE_BYTES_LIMIT = 1_048_576
MAX_CHUNK_LINES = 500
MAX_CHUNKS_LIMIT = 64
MAX_BATCH_SIZE = MAX_PATHS
MAX_TIME_BUDGET = 300.0

# Fixed strings only (never file content or exception text) so callers can allowlist them.
_BUDGET_TASK_WARNING = "task and path did not fit the Laya token budget; reading is recommended"
_BUDGET_CHUNK_WARNING = "a chunk did not fit the Laya token budget; reading is recommended"
_ACCOUNTING_WARNING = "Laya token accounting failed; reading is recommended"
_LONG_LINE_WARNING = "file contains an extremely long line; reading is recommended"
_CHUNK_LIMIT_WARNING = "chunk budget reached before complete coverage; the whole file is recommended"
_TIME_FILE_WARNING = "time budget exhausted before complete coverage; the whole file is recommended"
_TIME_CHUNK_WARNING = "time budget exhausted before this chunk was evaluated; reading is recommended"
_TIME_GLOBAL_WARNING = "time budget exhausted; unevaluated chunks are recommended for reading"
_TRUNCATED_EVIDENCE_WARNING = "Laya truncated chunk evidence; reading is recommended"
CONTEXT_SELECTION_WARNINGS = (
    _BUDGET_TASK_WARNING, _BUDGET_CHUNK_WARNING, _ACCOUNTING_WARNING, _LONG_LINE_WARNING, _CHUNK_LIMIT_WARNING,
    _TIME_FILE_WARNING, _TIME_CHUNK_WARNING, _TIME_GLOBAL_WARNING, _TRUNCATED_EVIDENCE_WARNING,
    _GENERIC_FALLBACK_WARNING,
    "file is missing; reading is recommended",
    "path could not be resolved safely; reading is recommended",
    "path escapes the project root; reading is recommended",
    "path could not be inspected; reading is recommended",
    "path is not a regular file; reading is recommended",
    "file exceeds the local read limit; reading is recommended",
    "file could not be read; reading is recommended",
    "file appears to be binary; reading is recommended",
    "file is not valid UTF-8 text; reading is recommended",
)

_monotonic = time.monotonic


@dataclass
class _Chunk:
    path: str
    start_line: int
    end_line: int
    state: dict
    text_fits: bool = True
    accounting_failed: bool = False


def select_context(task: str, paths: list[str], root: str = ".", backend=None, *,
                   head_max_len: int = DEFAULT_HEAD_MAX_LEN,
                   skip_threshold: float = DEFAULT_SKIP_THRESHOLD,
                   max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
                   chunk_lines: int = DEFAULT_CHUNK_LINES,
                   max_chunks: int = DEFAULT_MAX_CHUNKS,
                   batch_size: int = DEFAULT_BATCH_SIZE,
                   time_budget: float = DEFAULT_TIME_BUDGET) -> dict:
    """Read candidate files locally and return only paths/ranges the model should inspect.

    When time_budget (seconds) runs out, scheduling stops and unevaluated chunks are recommended for reading.
    """
    _require_text("task", task)
    if not task.strip():
        raise ValueError("task must be nonempty")
    if not isinstance(paths, list):
        raise TypeError("paths must be a list of strings")
    _validate_positive_int("head_max_len", head_max_len)
    _validate_positive_int("max_file_bytes", max_file_bytes, MAX_FILE_BYTES_LIMIT)
    _validate_positive_int("chunk_lines", chunk_lines, MAX_CHUNK_LINES)
    _validate_positive_int("max_chunks", max_chunks, MAX_CHUNKS_LIMIT)
    _validate_positive_int("batch_size", batch_size, MAX_BATCH_SIZE)
    _validate_skip_threshold(skip_threshold)
    _validate_time_budget(time_budget)
    deadline = _monotonic() + time_budget

    unique_paths = _dedupe_paths(paths)
    if len(unique_paths) > MAX_PATHS:
        raise ValueError("paths must contain at most %d entries" % MAX_PATHS)

    root_path = Path(root).resolve()
    questions = relevance_questions()
    files: list[dict] = []
    scheduled: list[_Chunk] = []
    chunk_slots_left = max_chunks
    global_warnings: list[str] = []
    reliable_backend = backend is not None and not isinstance(backend, HeuristicBackend)

    for raw_path in unique_paths:
        rel_path, actual_path, warning = _resolve_candidate(root_path, raw_path)
        if warning:
            files.append(_fallback_file(rel_path, None, False, [warning]))
            continue

        loaded = _read_text_file(actual_path, max_file_bytes)
        if loaded["warning"]:
            files.append(_fallback_file(rel_path, loaded["total_lines"], False, [loaded["warning"]]))
            continue

        lines = loaded["lines"]
        total_lines = loaded["total_lines"]
        if not reliable_backend:
            files.append(_result_file(rel_path, True, _whole_file_range(total_lines), total_lines, True,
                                      "conservative-fallback", [_GENERIC_FALLBACK_WARNING]))
            continue
        if total_lines == 0:
            files.append(_result_file(rel_path, False, [], 0, True, "laya", []))
            continue
        metadata_chunk = _make_chunk(task, rel_path, [], 0, 0)
        metadata_usage = _state_usage(backend, metadata_chunk.state, questions, head_max_len)
        if _usage_is_truncated(metadata_usage):
            warning = _ACCOUNTING_WARNING if metadata_usage.get("error") else _BUDGET_TASK_WARNING
            files.append(_fallback_file(rel_path, total_lines, False, [warning]))
            continue
        if any(len(line) > HUGE_LINE_CHARS for line in lines):
            files.append(_fallback_file(rel_path, total_lines, False, [_LONG_LINE_WARNING]))
            continue

        file_chunks = _chunks_for_file(task, rel_path, lines, chunk_lines, backend, questions, head_max_len,
                                       chunk_slots_left, deadline)
        if _expired(deadline):
            files.append(_result_file(rel_path, True, _whole_file_range(total_lines), total_lines, False,
                                      "conservative-fallback", [_TIME_FILE_WARNING]))
            continue
        if any(not chunk.text_fits for chunk in file_chunks):
            warning = _ACCOUNTING_WARNING if any(chunk.accounting_failed for chunk in file_chunks) else _BUDGET_CHUNK_WARNING
            files.append(_fallback_file(rel_path, total_lines, False, [warning]))
            continue
        if len(file_chunks) > chunk_slots_left:
            files.append(_result_file(rel_path, True, _whole_file_range(total_lines), total_lines, False,
                                      "conservative-fallback", [_CHUNK_LIMIT_WARNING]))
            chunk_slots_left = 0
            continue

        files.append(_result_file(rel_path, True, [], total_lines, True, "laya", []))
        scheduled.extend(file_chunks)
        chunk_slots_left -= len(file_chunks)

    if scheduled:
        try:
            results = _predict_chunks(backend, [chunk.state for chunk in scheduled], questions, head_max_len,
                                      batch_size, deadline)
        except (AttributeError, ImportError, KeyError, TypeError, ValueError, RuntimeError, OSError, OverflowError):
            results = None
            global_warnings.append(_GENERIC_FALLBACK_WARNING)
        if results is None:
            for file_result in files:
                budget_incomplete = _CHUNK_LIMIT_WARNING in file_result["warnings"]
                if file_result["source"] == "laya" or budget_incomplete:
                    file_result.update({
                        "should_read": True,
                        "ranges": _whole_file_range(file_result["total_lines"]),
                        "source": "conservative-fallback",
                        "warnings": [*file_result["warnings"], _GENERIC_FALLBACK_WARNING],
                    })
        else:
            _apply_chunk_results(files, scheduled, results, skip_threshold)
            if any(result is None for result in results):
                global_warnings.append(_TIME_GLOBAL_WARNING)

    return {"files": files, "warnings": global_warnings, "complete": all(file["complete"] for file in files)}


def _expired(deadline: float) -> bool:
    return _monotonic() >= deadline


def _chunks_for_file(task: str, rel_path: str, lines: list[str], chunk_lines: int, backend,
                     questions: dict, head_max_len: int, limit: int, deadline: float) -> list[_Chunk]:
    """Prepare chunks until the file needs more than `limit` of them or the deadline passes (callers check both)."""
    chunks: list[_Chunk] = []
    for start in range(0, len(lines), chunk_lines):
        if len(chunks) > limit or _expired(deadline):
            break
        _fit_chunk(task, rel_path, lines, start, min(start + chunk_lines, len(lines)),
                   backend, questions, head_max_len, chunks, limit, deadline)
    return chunks


def _fit_chunk(task: str, rel_path: str, lines: list[str], start: int, end: int, backend,
               questions: dict, head_max_len: int, out: list[_Chunk], limit: int, deadline: float) -> None:
    if len(out) > limit or _expired(deadline):
        return
    chunk = _make_chunk(task, rel_path, lines, start, end)
    usage = _state_usage(backend, chunk.state, questions, head_max_len)
    if usage is None or not _usage_is_truncated(usage):
        out.append(chunk)
        return
    if usage.get("error") or end - start <= 1:
        chunk.text_fits = False
        chunk.accounting_failed = bool(usage.get("error"))
        out.append(chunk)
        return
    mid = start + max(1, (end - start) // 2)
    _fit_chunk(task, rel_path, lines, start, mid, backend, questions, head_max_len, out, limit, deadline)
    _fit_chunk(task, rel_path, lines, mid, end, backend, questions, head_max_len, out, limit, deadline)


def _make_chunk(task: str, rel_path: str, lines: list[str], start: int, end: int) -> _Chunk:
    start_line = start + 1
    end_line = end
    return _Chunk(
        path=rel_path,
        start_line=start_line,
        end_line=end_line,
        state={
            "task": task,
            "candidate_path": rel_path,
            "candidate_range": "%d-%d" % (start_line, end_line),
            "candidate_excerpt": "\n".join(lines[start:end]),
        },
    )


def _apply_chunk_results(files: list[dict], chunks: list[_Chunk], results: list[dict | None],
                         skip_threshold: float) -> None:
    by_path = {file_result["path"]: file_result for file_result in files}
    recommended: dict[str, list[dict]] = {}
    forced_read: dict[str, list[str]] = {}
    saw_laya: set[str] = set()
    unevaluated: set[str] = set()

    for chunk, result in zip(chunks, results):
        file_result = by_path.get(chunk.path)
        if not file_result or file_result["source"] != "laya" or not file_result["complete"]:
            continue
        saw_laya.add(chunk.path)
        if result is None:
            unevaluated.add(chunk.path)
            forced_read.setdefault(chunk.path, []).append(_TIME_CHUNK_WARNING)
            recommended.setdefault(chunk.path, []).append(_range(chunk.start_line, chunk.end_line))
            continue
        try:
            answer = validate_answer(result["answers"]["relevance"], _OPTIONS)
        except (AttributeError, KeyError, TypeError, ValueError):
            forced_read.setdefault(chunk.path, []).append(_GENERIC_FALLBACK_WARNING)
            recommended.setdefault(chunk.path, []).append(_range(chunk.start_line, chunk.end_line))
            continue
        usage = _valid_usage(result.get("usage"))
        if usage is None or _usage_is_truncated(usage):
            forced_read.setdefault(chunk.path, []).append(_TRUNCATED_EVIDENCE_WARNING)
            recommended.setdefault(chunk.path, []).append(_range(chunk.start_line, chunk.end_line))
            continue
        p_no = float(answer["probabilities"]["no"])
        strongest_other = max(float(value) for key, value in answer["probabilities"].items() if key != "no")
        clear_skip = answer["choice"] == "no" and p_no >= skip_threshold and p_no > strongest_other
        if not clear_skip:
            recommended.setdefault(chunk.path, []).append(_range(chunk.start_line, chunk.end_line))

    for path in saw_laya:
        file_result = by_path[path]
        ranges = _merge_ranges(recommended.get(path, []))
        warnings = file_result["warnings"]
        if path in forced_read:
            warnings = [*warnings, *dict.fromkeys(forced_read[path])]
        file_result.update({
            "should_read": bool(ranges),
            "ranges": ranges,
            "complete": path not in unevaluated,
            "source": "laya" if path not in forced_read else "conservative-fallback",
            "warnings": warnings,
        })


def _predict_chunks(backend, states: list[dict], questions: dict, head_max_len: int, batch_size: int,
                    deadline: float) -> list[dict | None] | None:
    """Predict batch by batch without starting a batch that is estimated to outlast the deadline.

    The first batch is small to measure the per-chunk cost; later batches shrink to fit the remaining time.
    Chunks left over are returned as None (unevaluated).
    """
    if backend is None or isinstance(backend, HeuristicBackend):
        raise RuntimeError("no reliable backend")
    results: list[dict | None] = []
    seconds_per_chunk = 0.0
    size = min(batch_size, FIRST_BATCH_CHUNKS)
    while len(results) < len(states):
        if results:
            remaining = deadline - _monotonic()
            fits = int(remaining / seconds_per_chunk) if seconds_per_chunk > 0 else batch_size
            size = min(batch_size, fits)
        if size < 1 or _expired(deadline):
            break
        batch = states[len(results):len(results) + size]
        started = _monotonic()
        if hasattr(backend, "predict_batch"):
            try:
                batch_results = backend.predict_batch(batch, questions, head_max_len=head_max_len, batch_size=batch_size)
            except TypeError:
                batch_results = backend.predict_batch(batch, questions, head_max_len=head_max_len)
        else:
            batch_results = [backend.predict(state, questions, head_max_len) for state in batch]
        seconds_per_chunk = max(seconds_per_chunk, (_monotonic() - started) / len(batch))
        batch_results = _matched_results(batch_results, len(batch))
        if batch_results is None:
            return None
        results.extend(batch_results)
    results.extend([None] * (len(states) - len(results)))
    return results


def _matched_results(results: Any, expected: int) -> list[dict] | None:
    if not isinstance(results, list) or len(results) != expected:
        return None
    if not all(isinstance(result, dict) for result in results):
        return None
    return results


def _state_usage(backend, state: dict, questions: dict, head_max_len: int) -> dict | None:
    if not hasattr(backend, "state_usage"):
        return None
    try:
        return _valid_usage(backend.state_usage(state, questions, head_max_len=head_max_len))
    except (AttributeError, ImportError, KeyError, TypeError, ValueError, RuntimeError, OSError, OverflowError):
        # Accounting failed (not a real truncation): stay conservative but let callers word the warning accurately.
        return {"truncated": True, "state_tokens_dropped": 1, "error": True}


def _resolve_candidate(root: Path, raw_path: str) -> tuple[str, Path | None, str | None]:
    if not isinstance(raw_path, str):
        raise TypeError("paths entries must be strings")
    if not raw_path.strip():
        raise ValueError("paths entries must be nonempty")
    display = raw_path
    raw = Path(raw_path)
    candidate = raw if raw.is_absolute() else root / raw
    try:
        actual = candidate.resolve(strict=True)
    except FileNotFoundError:
        return display, None, "file is missing; reading is recommended"
    except (OSError, RuntimeError, ValueError):
        return display, None, "path could not be resolved safely; reading is recommended"
    if not _is_relative_to(actual, root):
        return display, None, "path escapes the project root; reading is recommended"
    try:
        mode = actual.stat().st_mode
    except OSError:
        return display, None, "path could not be inspected; reading is recommended"
    if not stat.S_ISREG(mode):
        return display, None, "path is not a regular file; reading is recommended"
    return display, actual, None


def _read_text_file(path: Path | None, max_file_bytes: int) -> dict:
    if path is None:
        return {"lines": [], "warning": "file is missing; reading is recommended", "total_lines": None}
    try:
        with path.open("rb") as handle:
            data = handle.read(max_file_bytes + 1)
        if len(data) > max_file_bytes:
            return {"lines": [], "warning": "file exceeds the local read limit; reading is recommended", "total_lines": None}
    except OSError:
        return {"lines": [], "warning": "file could not be read; reading is recommended", "total_lines": None}
    if b"\x00" in data:
        return {"lines": [], "warning": "file appears to be binary; reading is recommended", "total_lines": None}
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return {"lines": [], "warning": "file is not valid UTF-8 text; reading is recommended", "total_lines": None}
    lines = _split_lines(text)
    return {"lines": lines, "warning": None, "total_lines": len(lines)}


def _split_lines(text: str) -> list[str]:
    """Split on LF only (CRLF normalized) so line numbers match editors; str.splitlines() also breaks on form feed, VT, NEL and U+2028."""
    lines = text.replace("\r\n", "\n").split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return lines


def _fallback_file(path: str, total_lines: int | None, complete: bool, warnings: list[str]) -> dict:
    return _result_file(path, True, [], total_lines, complete, "conservative-fallback",
                        [*warnings, _GENERIC_FALLBACK_WARNING])


def _result_file(path: str, should_read: bool, ranges: list[dict], total_lines: int | None,
                 complete: bool, source: str, warnings: list[str]) -> dict:
    return {
        "path": path,
        "should_read": bool(should_read),
        "ranges": ranges,
        "total_lines": total_lines,
        "complete": bool(complete),
        "source": source,
        "warnings": warnings,
    }


def _dedupe_paths(paths: list[str]) -> list[str]:
    seen = set()
    unique = []
    for path in paths:
        if not isinstance(path, str):
            raise TypeError("paths entries must be strings")
        if path not in seen:
            seen.add(path)
            unique.append(path)
    return unique


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _whole_file_range(total_lines: int | None) -> list[dict]:
    return [_range(1, total_lines)] if total_lines else []


def _merge_ranges(ranges: list[dict]) -> list[dict]:
    merged: list[dict] = []
    for current in sorted(ranges, key=lambda item: (item["start_line"], item["end_line"])):
        if not merged or current["start_line"] > merged[-1]["end_line"] + 1:
            merged.append(dict(current))
        else:
            merged[-1]["end_line"] = max(merged[-1]["end_line"], current["end_line"])
    return merged


def _range(start_line: int, end_line: int) -> dict:
    return {"start_line": int(start_line), "end_line": int(end_line)}


def _require_text(name: str, value: Any) -> None:
    if not isinstance(value, str):
        raise TypeError("%s must be a string" % name)


def _validate_positive_int(name: str, value: int, maximum: int | None = None) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ValueError("%s must be a positive integer" % name)
    if maximum is not None and value > maximum:
        raise ValueError("%s must be at most %d" % (name, maximum))


def _validate_time_budget(value: float) -> None:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise ValueError("time_budget must be a finite number")
    if value < 0 or value > MAX_TIME_BUDGET:
        raise ValueError("time_budget must be in [0, %d]" % MAX_TIME_BUDGET)


def _validate_skip_threshold(value: float) -> None:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise ValueError("skip_threshold must be a finite number")
    if value < 0.5 or value > 1:
        raise ValueError("skip_threshold must be in [0.5, 1]")
