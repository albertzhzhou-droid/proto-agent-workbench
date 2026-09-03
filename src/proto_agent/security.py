from __future__ import annotations

import json
import os
import re
import stat as stat_module
from uuid import uuid4
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import Any, Iterable


MAX_PATH_CHARS = 512
MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024
# Bounded workspace JSON reads.  The reviewed materials seeds legitimately
# reach a few MB (1000+ sequence records), so this cap stays generous but
# finite; unbounded reads remain rejected everywhere.
MAX_JSON_FILE_BYTES = 8 * 1024 * 1024
MAX_NOTEBOOK_FILE_BYTES = 4 * 1024 * 1024
MAX_FIXTURE_FILE_BYTES = 2 * 1024 * 1024
MAX_CA_FILE_BYTES = 1024 * 1024
MAX_OUTPUT_FILE_BYTES = 8 * 1024 * 1024

_WINDOWS_DEVICE_NAME = re.compile(
    r"^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$",
    re.IGNORECASE,
)


class SecurityBoundaryError(ValueError):
    """Raised when an untrusted path or payload crosses a declared boundary."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class WorkspacePaths:
    workspace: Path
    build: Path
    cache: Path

    @classmethod
    def create(cls, workspace: str | Path | None = None) -> "WorkspacePaths":
        requested = Path.cwd() if workspace is None else Path(workspace)
        _assert_absolute_components_no_reparse(requested.absolute())
        try:
            canonical = requested.resolve(strict=True)
        except FileNotFoundError as exc:
            raise SecurityBoundaryError("WORKSPACE_NOT_FOUND", f"Workspace does not exist: {requested}") from exc
        except OSError as exc:
            raise SecurityBoundaryError("WORKSPACE_UNREADABLE", f"Workspace cannot be resolved safely: {requested}") from exc
        if not canonical.is_dir():
            raise SecurityBoundaryError("WORKSPACE_NOT_DIRECTORY", f"Workspace is not a directory: {canonical}")
        build = canonical / "build"
        cache = build / "cache"
        policy = cls(canonical, build, cache)
        policy.ensure_directory(build, boundary=canonical)
        policy.ensure_directory(cache, boundary=build)
        return policy

    def workspace_file(
        self,
        value: str | Path,
        *,
        extensions: Iterable[str] | None = None,
        max_bytes: int = MAX_TEXT_FILE_BYTES,
    ) -> Path:
        candidate = self._resolve_relative(value, self.workspace, must_exist=True)
        self._require_regular_file(candidate, extensions=extensions, max_bytes=max_bytes)
        return candidate

    def workspace_entry(self, value: str | Path) -> Path:
        """Resolve an existing non-reparse file or directory under the workspace."""

        candidate = self._resolve_relative(value, self.workspace, must_exist=True)
        self._reject_existing_symlink(candidate)
        return candidate

    def fixture_file(self, value: str | Path, *, extensions: Iterable[str]) -> Path:
        return self.workspace_file(value, extensions=extensions, max_bytes=MAX_FIXTURE_FILE_BYTES)

    def ca_file(self, value: str | Path) -> Path:
        return self.workspace_file(
            value,
            extensions={".pem", ".crt", ".cer"},
            max_bytes=MAX_CA_FILE_BYTES,
        )

    def build_file(
        self,
        value: str | Path,
        *,
        extensions: Iterable[str] | None = None,
        must_exist: bool = False,
    ) -> Path:
        candidate = self._resolve_relative(value, self.workspace, must_exist=must_exist)
        self._assert_contained(self.build, candidate, "PATH_OUTSIDE_BUILD")
        if must_exist:
            self._require_regular_file(candidate, extensions=extensions, max_bytes=MAX_OUTPUT_FILE_BYTES)
        else:
            self._require_extension(candidate, extensions)
            self.ensure_directory(candidate.parent, boundary=self.build)
            self._reject_existing_symlink(candidate)
        return candidate

    def build_directory(self, value: str | Path) -> Path:
        candidate = self._resolve_relative(value, self.workspace, must_exist=False)
        self._assert_contained(self.build, candidate, "PATH_OUTSIDE_BUILD")
        self.ensure_directory(candidate, boundary=self.build)
        return candidate

    def cache_directory(self, value: str | Path) -> Path:
        candidate = self._resolve_relative(value, self.workspace, must_exist=False)
        self._assert_contained(self.cache, candidate, "PATH_OUTSIDE_CACHE")
        self.ensure_directory(candidate, boundary=self.cache)
        return candidate

    def run_directory(self, base: str | Path, run_id: str) -> Path:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", run_id):
            raise SecurityBoundaryError("INVALID_RUN_ID", "Run identifiers may contain only letters, digits, dot, dash, and underscore.")
        base_dir = self.build_directory(base)
        run_dir = base_dir / run_id
        self.ensure_directory(run_dir, boundary=self.build)
        return run_dir

    def ensure_directory(self, path: str | Path, *, boundary: str | Path) -> Path:
        candidate = Path(path)
        root = Path(boundary).resolve(strict=True)
        self._assert_contained(root, candidate, "PATH_OUTSIDE_BOUNDARY")
        relative = candidate.relative_to(root)
        current = root
        for part in relative.parts:
            current = current / part
            info = _lstat_or_none(current)
            if info is not None:
                self._reject_existing_symlink(current)
                if not stat_module.S_ISDIR(info.st_mode):
                    raise SecurityBoundaryError("NOT_A_DIRECTORY", f"Expected a directory: {current}")
                continue
            current.mkdir()
            self._reject_existing_symlink(current)
        canonical = candidate.resolve(strict=True)
        self._assert_contained(root, canonical, "SYMLINK_ESCAPE")
        return canonical

    def _resolve_relative(self, value: str | Path, root: Path, *, must_exist: bool) -> Path:
        raw = str(value)
        _validate_relative_path_text(raw)
        candidate = root.joinpath(*raw.replace("\\", "/").split("/"))
        self._assert_contained(root, candidate, "PATH_TRAVERSAL")
        self._assert_no_symlink_components(root, candidate, include_leaf=must_exist)
        if must_exist:
            try:
                canonical = candidate.resolve(strict=True)
            except (FileNotFoundError, OSError) as exc:
                raise SecurityBoundaryError("FILE_NOT_FOUND", f"File does not exist: {raw}") from exc
            self._assert_contained(root, canonical, "SYMLINK_ESCAPE")
            return canonical
        parent = candidate.parent
        existing_parent = parent
        while not existing_parent.exists() and existing_parent != root:
            existing_parent = existing_parent.parent
        canonical_parent = existing_parent.resolve(strict=True)
        self._assert_contained(root, canonical_parent, "SYMLINK_ESCAPE")
        return candidate

    @staticmethod
    def _assert_contained(root: Path, candidate: Path, code: str) -> None:
        try:
            candidate.absolute().relative_to(root.absolute())
        except ValueError as exc:
            raise SecurityBoundaryError(code, f"Path is outside the permitted boundary: {candidate}") from exc

    @staticmethod
    def _reject_existing_symlink(path: Path) -> None:
        if _is_reparse_or_symlink(path):
            raise SecurityBoundaryError(
                "REPARSE_POINT_NOT_ALLOWED",
                f"Symbolic links, junctions, and reparse points are not allowed: {path}",
            )

    def _assert_no_symlink_components(self, root: Path, candidate: Path, *, include_leaf: bool) -> None:
        relative = candidate.relative_to(root)
        parts = relative.parts if include_leaf else relative.parts[:-1]
        current = root
        for part in parts:
            current = current / part
            self._reject_existing_symlink(current)

    @staticmethod
    def _require_extension(path: Path, extensions: Iterable[str] | None) -> None:
        if extensions is None:
            return
        normalized = {item.lower() if item.startswith(".") else f".{item.lower()}" for item in extensions}
        if path.suffix.lower() not in normalized:
            raise SecurityBoundaryError(
                "EXTENSION_NOT_ALLOWED",
                f"File extension {path.suffix or '<none>'} is not permitted; expected one of {sorted(normalized)}.",
            )

    def _require_regular_file(
        self,
        path: Path,
        *,
        extensions: Iterable[str] | None,
        max_bytes: int,
    ) -> None:
        self._require_extension(path, extensions)
        try:
            info = path.stat(follow_symlinks=False)
        except OSError as exc:
            raise SecurityBoundaryError("FILE_UNREADABLE", f"Unable to inspect file: {path}") from exc
        if not stat_module.S_ISREG(info.st_mode):
            raise SecurityBoundaryError("NOT_A_REGULAR_FILE", f"Only regular files are permitted: {path}")
        if info.st_nlink != 1:
            raise SecurityBoundaryError("HARDLINK_NOT_ALLOWED", "Files with multiple hard links are not permitted.")
        if info.st_size > max_bytes:
            raise SecurityBoundaryError(
                "FILE_TOO_LARGE",
                f"File exceeds the {max_bytes}-byte limit: {path}",
            )


def read_bytes_bounded(path: str | Path, max_bytes: int) -> bytes:
    source = Path(path).absolute()
    _assert_absolute_components_no_reparse(source)
    try:
        canonical_before = source.resolve(strict=True)
        parent_before = source.parent.resolve(strict=True)
    except FileNotFoundError as exc:
        raise SecurityBoundaryError("FILE_NOT_FOUND", f"File does not exist: {source}") from exc
    except OSError as exc:
        raise SecurityBoundaryError("FILE_UNREADABLE", f"Unable to resolve file safely: {source}") from exc
    parent_identity = _path_identity(parent_before)
    before = _lstat_or_none(source)
    if before is None:
        raise SecurityBoundaryError("FILE_NOT_FOUND", f"File does not exist: {source}")
    if not stat_module.S_ISREG(before.st_mode):
        raise SecurityBoundaryError("NOT_A_REGULAR_FILE", f"Only regular files are readable: {source}")
    if before.st_nlink != 1:
        raise SecurityBoundaryError("HARDLINK_NOT_ALLOWED", "Files with multiple hard links are not readable.")
    if before.st_size > max_bytes:
        raise SecurityBoundaryError("FILE_TOO_LARGE", f"File exceeds the {max_bytes}-byte limit: {source}")
    flags = os.O_RDONLY
    if hasattr(os, "O_BINARY"):
        flags |= os.O_BINARY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(source, flags)
    except OSError as exc:
        raise SecurityBoundaryError("FILE_UNREADABLE", f"Unable to open file safely: {source}") from exc
    with os.fdopen(descriptor, "rb") as handle:
        opened = os.fstat(handle.fileno())
        if not stat_module.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
            raise SecurityBoundaryError("READ_RACE_DETECTED", "Opened file is not a single-link regular file.")
        if _stat_identity(opened) != _stat_identity(before):
            raise SecurityBoundaryError("READ_RACE_DETECTED", f"File changed before it could be opened safely: {source}")
        payload = handle.read(max_bytes + 1)
    if len(payload) > max_bytes:
        raise SecurityBoundaryError("FILE_TOO_LARGE", f"File exceeds the {max_bytes}-byte limit: {source}")
    after = _lstat_or_none(source)
    if (
        after is None
        or not stat_module.S_ISREG(after.st_mode)
        or after.st_nlink != 1
        or _stat_identity(after) != _stat_identity(before)
    ):
        raise SecurityBoundaryError("READ_RACE_DETECTED", f"File changed while it was being read: {source}")
    _assert_absolute_components_no_reparse(source)
    try:
        canonical_after = source.resolve(strict=True)
        parent_after = source.parent.resolve(strict=True)
    except OSError as exc:
        raise SecurityBoundaryError("READ_RACE_DETECTED", f"File path changed while it was being read: {source}") from exc
    if canonical_after != canonical_before or parent_after != parent_before or _path_identity(parent_after) != parent_identity:
        raise SecurityBoundaryError("READ_RACE_DETECTED", f"File path changed while it was being read: {source}")
    return payload


def read_text_bounded(path: str | Path, max_bytes: int = MAX_TEXT_FILE_BYTES) -> str:
    payload = read_bytes_bounded(path, max_bytes)
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SecurityBoundaryError("INVALID_UTF8", f"File is not valid UTF-8: {path}") from exc


def read_json_bounded(path: str | Path, max_bytes: int = MAX_JSON_FILE_BYTES) -> Any:
    text = read_text_bounded(path, max_bytes)
    from .json_validation import JsonValidationError, strict_json_loads

    try:
        return strict_json_loads(text, max_bytes=max_bytes)
    except JsonValidationError as exc:
        raise SecurityBoundaryError("INVALID_JSON", f"Invalid JSON in {path}: {exc}") from exc


def write_text_bounded(
    path: str | Path,
    text: str,
    max_bytes: int = MAX_OUTPUT_FILE_BYTES,
    *,
    boundary: str | Path | None = None,
) -> None:
    target = Path(path)
    encoded = text.encode("utf-8")
    if len(encoded) > max_bytes:
        raise SecurityBoundaryError("OUTPUT_TOO_LARGE", f"Output exceeds the {max_bytes}-byte limit: {target}")
    original_parent = target.parent.absolute()
    if boundary is None:
        _assert_absolute_components_no_reparse(original_parent)
        canonical_boundary = original_parent.resolve(strict=True)
    else:
        requested_boundary = Path(boundary).absolute()
        _assert_absolute_components_no_reparse(requested_boundary)
        canonical_boundary = requested_boundary.resolve(strict=True)
        _assert_no_reparse_between(canonical_boundary, original_parent)
    parent = original_parent.resolve(strict=True)
    WorkspacePaths._assert_contained(canonical_boundary, parent, "PATH_OUTSIDE_BOUNDARY")
    if _is_reparse_or_symlink(parent) or _is_reparse_or_symlink(target):
        raise SecurityBoundaryError("REPARSE_POINT_NOT_ALLOWED", f"Reparse points are not writable: {target}")
    parent_identity = _path_identity(parent)
    temporary = parent / f".{target.name}.proto-agent-{uuid4().hex}.tmp"
    temporary_name = temporary.name
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    directory_descriptor: int | None = None
    try:
        if os.name != "nt":
            directory_flags = os.O_RDONLY
            if hasattr(os, "O_DIRECTORY"):
                directory_flags |= os.O_DIRECTORY
            if hasattr(os, "O_NOFOLLOW"):
                directory_flags |= os.O_NOFOLLOW
            directory_descriptor = os.open(parent, directory_flags)
            if _stat_identity(os.fstat(directory_descriptor))[:2] != parent_identity:
                raise SecurityBoundaryError("WRITE_RACE_DETECTED", "Output directory changed before it could be opened safely.")
            descriptor = os.open(temporary_name, flags, 0o600, dir_fd=directory_descriptor)
        else:
            # Windows stdlib has no rename-at/no-follow directory-handle API. The
            # identity and canonical-path checks below narrow, but cannot erase,
            # the final same-user rename race; workspace ACL isolation is still required.
            descriptor = os.open(temporary, flags, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        canonical_parent = target.parent.resolve(strict=True)
        WorkspacePaths._assert_contained(canonical_boundary, canonical_parent, "SYMLINK_ESCAPE")
        if _is_reparse_or_symlink(canonical_parent) or _path_identity(canonical_parent) != parent_identity:
            raise SecurityBoundaryError("WRITE_RACE_DETECTED", "Output directory changed while the file was being written.")
        if _is_reparse_or_symlink(target):
            raise SecurityBoundaryError("WRITE_RACE_DETECTED", "Output target became a reparse point before replacement.")
        if directory_descriptor is not None:
            os.replace(
                temporary_name,
                target.name,
                src_dir_fd=directory_descriptor,
                dst_dir_fd=directory_descriptor,
            )
            os.fsync(directory_descriptor)
        else:
            os.replace(temporary, target)
    except OSError as exc:
        raise SecurityBoundaryError("OUTPUT_WRITE_FAILED", f"Unable to write output: {target}") from exc
    finally:
        try:
            if directory_descriptor is not None:
                try:
                    os.unlink(temporary_name, dir_fd=directory_descriptor)
                except FileNotFoundError:
                    pass
            else:
                temporary.unlink(missing_ok=True)
        except OSError:
            pass
        if directory_descriptor is not None:
            os.close(directory_descriptor)


def list_regular_files_bounded(
    directory: str | Path,
    *,
    max_bytes: int = MAX_OUTPUT_FILE_BYTES,
    exclude: Iterable[str] = (),
) -> list[str]:
    requested_root = Path(directory).absolute()
    _assert_absolute_components_no_reparse(requested_root)
    root = requested_root.resolve(strict=True)
    excluded = set(exclude)
    results: list[str] = []
    for path in sorted(root.iterdir()):
        if path.name in excluded or _is_reparse_or_symlink(path):
            continue
        try:
            info = path.stat(follow_symlinks=False)
        except OSError as exc:
            raise SecurityBoundaryError("PATH_INSPECTION_FAILED", f"Unable to inspect artifact safely: {path}") from exc
        if stat_module.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= max_bytes:
            results.append(str(path))
    return results


def public_workspace_payload(payload: dict[str, Any], workspace: str | Path) -> dict[str, Any]:
    """Copy a result while converting known internal path fields to root-relative text."""

    root = Path(workspace).resolve(strict=True)
    return _normalize_public_workspace_paths(payload, root)


def _normalize_public_workspace_paths(
    value: Any,
    workspace: Path,
    *,
    parent_key: str = "",
) -> Any:
    if isinstance(value, list):
        return [
            _normalize_public_workspace_paths(item, workspace, parent_key=parent_key)
            for item in value
        ]
    if not isinstance(value, dict):
        return value
    result: dict[str, Any] = {}
    for key, nested in value.items():
        if (
            isinstance(nested, str)
            and nested
            and (
                key in {"file", "cache_path", "registry", "manifest_path", "provenance_path"}
                or (key == "source" and parent_key == "provenance")
            )
        ):
            result[key] = _public_workspace_path(nested, workspace)
        else:
            result[key] = _normalize_public_workspace_paths(
                nested,
                workspace,
                parent_key=key,
            )
    return result


def _public_workspace_path(value: str, workspace: Path) -> str:
    path = Path(value)
    if not path.is_absolute():
        return path.as_posix()
    try:
        return path.absolute().relative_to(workspace).as_posix()
    except ValueError:
        return "<outside-workspace>"


def _validate_relative_path_text(raw: str) -> None:
    if not raw or len(raw) > MAX_PATH_CHARS:
        raise SecurityBoundaryError("INVALID_PATH", f"Path must contain 1 to {MAX_PATH_CHARS} characters.")
    if any(ord(character) < 32 or ord(character) == 127 for character in raw):
        raise SecurityBoundaryError("INVALID_PATH", "Control characters are not allowed in paths.")
    normalized = raw.replace("\\", "/")
    lowered = normalized.lower()
    if any(token in lowered for token in ("%00", "%2e", "%2f", "%5c")):
        raise SecurityBoundaryError(
            "ENCODED_PATH_TOKEN",
            "Percent-encoded NUL, dot, and path-separator tokens are not allowed.",
        )
    windows = PureWindowsPath(raw)
    if (
        Path(raw).is_absolute()
        or windows.is_absolute()
        or bool(windows.drive)
        or normalized.startswith("/")
        or lowered.startswith(("//", "\\\\?\\", "\\\\.\\", "\\??\\", "globalroot"))
    ):
        raise SecurityBoundaryError("ABSOLUTE_PATH_NOT_ALLOWED", "Absolute, UNC, and device paths are not allowed.")
    parts = normalized.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise SecurityBoundaryError("PATH_TRAVERSAL", "Empty, dot, and parent path segments are not allowed.")
    for part in parts:
        if part.endswith((" ", ".")) or ":" in part or _WINDOWS_DEVICE_NAME.fullmatch(part):
            raise SecurityBoundaryError("INVALID_PATH_COMPONENT", f"Unsafe path component: {part}")


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise SecurityBoundaryError("DUPLICATE_JSON_KEY", f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def _path_identity(path: Path) -> tuple[int, int]:
    info = path.stat(follow_symlinks=False)
    return info.st_dev, info.st_ino


def is_reparse_point(path: str | Path) -> bool:
    return _is_reparse_or_symlink(Path(path))


def _is_reparse_or_symlink(path: Path) -> bool:
    info = _lstat_or_none(path)
    if info is None:
        return False
    if stat_module.S_ISLNK(info.st_mode):
        return True
    is_junction = getattr(path, "is_junction", None)
    try:
        if callable(is_junction) and is_junction():
            return True
    except OSError as exc:
        raise SecurityBoundaryError("PATH_INSPECTION_FAILED", f"Unable to inspect reparse status: {path}") from exc
    attributes = getattr(info, "st_file_attributes", 0)
    reparse_flag = getattr(stat_module, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_flag)


def _lstat_or_none(path: Path) -> os.stat_result | None:
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise SecurityBoundaryError("PATH_INSPECTION_FAILED", f"Unable to inspect path safely: {path}") from exc


def _stat_identity(info: os.stat_result) -> tuple[int, int, int, int, int]:
    # Python 3.12 gives Windows path-stat and descriptor-stat different ctime
    # semantics.  Birth time is stable across both APIs when available, while
    # mtime catches ordinary writes; older Python/POSIX retain ctime here.
    birth_or_change_ns = getattr(info, "st_birthtime_ns", info.st_ctime_ns)
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, birth_or_change_ns


def _assert_absolute_components_no_reparse(path: Path) -> None:
    absolute = path.absolute()
    anchor = Path(absolute.anchor)
    current = anchor
    for part in absolute.parts[1:]:
        current = current / part
        info = _lstat_or_none(current)
        if info is None:
            break
        if _is_reparse_or_symlink(current):
            raise SecurityBoundaryError(
                "REPARSE_POINT_NOT_ALLOWED",
                f"Workspace and file paths may not traverse a symbolic link, junction, or reparse point: {current}",
            )


def _assert_no_reparse_between(root: Path, candidate: Path) -> None:
    try:
        relative = candidate.absolute().relative_to(root.absolute())
    except ValueError as exc:
        raise SecurityBoundaryError("PATH_OUTSIDE_BOUNDARY", f"Path is outside the permitted boundary: {candidate}") from exc
    current = root
    if _is_reparse_or_symlink(current):
        raise SecurityBoundaryError("REPARSE_POINT_NOT_ALLOWED", f"Boundary is a reparse point: {current}")
    for part in relative.parts:
        current = current / part
        if _is_reparse_or_symlink(current):
            raise SecurityBoundaryError("REPARSE_POINT_NOT_ALLOWED", f"Path traverses a reparse point: {current}")
