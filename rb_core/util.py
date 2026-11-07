"""Small shared helpers: errors, argument checks, the data directory, atomic writes."""

import json
import os
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR_ENV = "REDMINE_BOARD_DATA_DIR"
MAX_STRING_BYTES = 64 * 1024


class ToolError(Exception):
    """An error whose message is safe to show to the UI and to the agent.

    ``code`` maps to an HTTP status in the backend. Messages never carry the
    API key (``client.scrub`` runs over anything that came from Redmine).
    """

    def __init__(self, message, code="bad_request"):
        super().__init__(message)
        self.code = code


def data_dir():
    override = os.environ.get(DATA_DIR_ENV)
    return Path(override) if override else APP_ROOT / "data"


def atomic_write_json(path, obj, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except (OSError, ValueError):
        return default


def check_str(value, field):
    if not isinstance(value, str):
        raise ToolError(f"{field} must be a string")
    if len(value.encode("utf-8")) > MAX_STRING_BYTES:
        raise ToolError(f"{field} exceeds {MAX_STRING_BYTES} bytes")
    return value


def str_arg(args, name, required=False, default=None):
    v = args.get(name)
    if v is None or v == "":
        if required:
            raise ToolError(f"missing required argument: {name}")
        return default
    return check_str(v, name)


def int_arg(args, name, required=False, default=None, lo=None, hi=None):
    v = args.get(name)
    if v is None or v == "":
        if required:
            raise ToolError(f"missing required argument: {name}")
        return default
    if isinstance(v, str) and v.strip().lstrip("-").isdigit():
        v = int(v.strip())
    if not isinstance(v, int) or isinstance(v, bool):
        raise ToolError(f"{name} must be an integer")
    if lo is not None and v < lo:
        raise ToolError(f"{name} must be >= {lo}")
    if hi is not None and v > hi:
        raise ToolError(f"{name} must be <= {hi}")
    return v
