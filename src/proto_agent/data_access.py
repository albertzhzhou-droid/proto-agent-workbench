from __future__ import annotations

import base64
import hashlib
import json
import math
import stat
from datetime import date, datetime, time
from decimal import Decimal
from pathlib import Path
from typing import Any

from .security import SecurityBoundaryError, WorkspacePaths, read_bytes_bounded


MAX_DATASET_FILE_BYTES = 32 * 1024 * 1024 * 1024
MAX_PAGE_ROWS = 100
MAX_PAGE_COLUMNS = 32
MAX_PAGE_DECODE_BYTES = 64 * 1024 * 1024
MAX_PAGE_RESPONSE_BYTES = 384 * 1024
MAX_ARRAY_RANK = 16
MAX_ARRAY_CHUNK_BYTES = 16 * 1024 * 1024
MAX_ARRAY_CHUNK_ELEMENTS = 8_192


class DataReadError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def read_dataset_page(
    *,
    paths: WorkspacePaths,
    path: str,
    offset: int,
    limit: int,
    columns: list[str] | None = None,
    expected_source_version: str | None = None,
    cancel_event: Any = None,
) -> dict[str, Any]:
    """Read one bounded row page from a local Parquet file."""
    _require_int(offset, "offset", minimum=0)
    _require_int(limit, "limit", minimum=1, maximum=MAX_PAGE_ROWS)
    if columns is not None and (
        not isinstance(columns, list)
        or not columns
        or len(columns) > MAX_PAGE_COLUMNS
        or any(not isinstance(item, str) or not item or len(item) > 256 for item in columns)
        or len(set(columns)) != len(columns)
    ):
        raise DataReadError("INVALID_COLUMNS", f"columns must contain 1 to {MAX_PAGE_COLUMNS} unique column names.")
    if offset > 0 and not expected_source_version:
        raise DataReadError("SOURCE_VERSION_REQUIRED", "Pass the source_version returned by the first page to continue a transcript without gaps.")

    try:
        source = paths.workspace_file(path, extensions={".parquet"}, max_bytes=MAX_DATASET_FILE_BYTES)
    except SecurityBoundaryError as exc:
        raise DataReadError(exc.code, str(exc)) from exc
    before = _file_identity(source)
    source_version = _source_version(before)
    if expected_source_version is not None and expected_source_version != source_version:
        raise DataReadError("SOURCE_CHANGED", "The Parquet file changed between pages; restart paging from offset 0.")

    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError as exc:
        raise DataReadError("PARQUET_READER_UNAVAILABLE", "Install the optional proto-agent[data-read] dependencies to read Parquet files.") from exc

    parquet: Any = None
    try:
        parquet = pq.ParquetFile(source, page_checksum_verification=True)
        metadata = parquet.metadata
        total_rows = int(metadata.num_rows)
        if offset > total_rows:
            raise DataReadError("ROW_OFFSET_OUT_OF_RANGE", f"offset {offset} exceeds the {total_rows}-row table.")

        schema = parquet.schema_arrow
        schema_names = list(schema.names)
        if not schema_names:
            raise DataReadError("EMPTY_TABLE_SCHEMA", "The Parquet file has no named columns, so row identity cannot be reported safely.")
        if len(set(schema_names)) != len(schema_names):
            raise DataReadError("DUPLICATE_COLUMN_NAMES", "The table has duplicate top-level column names; column identity is ambiguous.")
        selected = schema_names if columns is None else columns
        missing = [name for name in selected if name not in schema_names]
        if missing:
            raise DataReadError("COLUMN_NOT_FOUND", f"Requested columns are absent: {missing}.")
        fields = [schema.field(name) for name in selected]
        nested = [field.name for field in fields if pa.types.is_nested(field.type)]
        if nested:
            raise DataReadError("NESTED_COLUMNS_UNSUPPORTED", f"Nested columns are not yet supported in row pages: {nested}.")

        end = min(total_rows, offset + limit)
        row_groups: list[tuple[int, int, int]] = []
        group_start = 0
        selected_set = set(selected)
        for group_index in range(metadata.num_row_groups):
            group = metadata.row_group(group_index)
            group_end = group_start + int(group.num_rows)
            if group_start < end and group_end > offset:
                selected_bytes = 0
                for column_index in range(group.num_columns):
                    column = group.column(column_index)
                    top_level_name = str(column.path_in_schema).split(".", 1)[0]
                    if top_level_name in selected_set:
                        selected_bytes += int(column.total_uncompressed_size)
                row_groups.append((group_index, group_start, group_end))
                if selected_bytes > MAX_PAGE_DECODE_BYTES:
                    raise DataReadError(
                        "ROW_GROUP_TOO_LARGE",
                        f"The selected columns in row group {group_index} require more than {MAX_PAGE_DECODE_BYTES} uncompressed bytes; no rows were returned.",
                    )
            group_start = group_end

        decode_bytes = 0
        for group_index, _, _ in row_groups:
            group = metadata.row_group(group_index)
            selected_set = set(selected)
            decode_bytes += sum(
                int(group.column(column_index).total_uncompressed_size)
                for column_index in range(group.num_columns)
                if str(group.column(column_index).path_in_schema).split(".", 1)[0] in selected_set
            )
        if decode_bytes > MAX_PAGE_DECODE_BYTES:
            raise DataReadError(
                "PAGE_DECODE_BUDGET_EXCEEDED",
                f"The requested page spans row groups requiring {decode_bytes} uncompressed bytes; the per-page limit is {MAX_PAGE_DECODE_BYTES}.",
            )

        rows: list[dict[str, Any]] = []
        if end > offset:
            for group_index, group_start, group_end in row_groups:
                _check_cancelled(cancel_event)
                local_start = max(0, offset - group_start)
                local_end = min(group_end - group_start, end - group_start)
                if local_start >= local_end:
                    continue
                batch_start = 0
                for batch in parquet.iter_batches(
                    batch_size=min(MAX_PAGE_ROWS, max(1, local_end - local_start)),
                    row_groups=[group_index],
                    columns=selected,
                    use_threads=False,
                ):
                    batch_end = batch_start + batch.num_rows
                    take_start = max(batch_start, local_start)
                    take_end = min(batch_end, local_end)
                    for row_index in range(take_start, take_end):
                        record: dict[str, Any] = {}
                        local_row = row_index - batch_start
                        for column_index, field in enumerate(fields):
                            scalar = batch.column(column_index)[local_row]
                            record[field.name] = _arrow_value(scalar, field.type, pa)
                        rows.append(record)
                    batch_start = batch_end

        if _file_identity(source) != before:
            raise DataReadError("SOURCE_CHANGED", "The Parquet file changed while this page was being read; discard the page and restart.")
        if len(rows) != end - offset:
            raise DataReadError(
                "PARQUET_RANGE_INCOMPLETE",
                f"The requested Parquet row range [{offset}, {end}) produced {len(rows)} of {end - offset} rows; no partial page was returned.",
            )
        schema_payload = [
            {"name": field.name, "type": str(field.type), "nullable": bool(field.nullable)}
            for field in fields
        ]
        schema_sha256 = _sha256_json(schema_payload)
        page_sha256 = _sha256_json(rows)
        next_offset = offset + len(rows)
        payload = {
            "ok": True,
            "kind": "table_page",
            "format": "parquet",
            "source": path,
            "source_version": source_version,
            "source_version_kind": "size-mtime-inode; not a content hash",
            "schema": schema_payload,
            "schema_sha256": schema_sha256,
            "rows": rows,
            "row_range": {"start": offset, "end_exclusive": next_offset, "total_rows": total_rows},
            "next_offset": next_offset if next_offset < total_rows else None,
            "page_sha256": page_sha256,
            "page_hash_scope": "canonical JSON for the returned rows only",
            "page_checksum_verification": True,
        }
        _enforce_response_budget(payload, MAX_PAGE_RESPONSE_BYTES)
        return payload
    except DataReadError:
        raise
    except Exception as exc:
        raise DataReadError(
            "PARQUET_RANGE_UNREADABLE",
            f"The requested Parquet row range [{offset}, {min(offset + limit, locals().get('total_rows', offset + limit))}) could not be read; the range remains explicitly unavailable ({type(exc).__name__}).",
        ) from exc
    finally:
        if parquet is not None:
            close = getattr(parquet, "close", None)
            if callable(close):
                close()


def read_array_chunk(
    *,
    paths: WorkspacePaths,
    path: str,
    chunk_indices: list[int],
    expected_metadata_sha256: str | None = None,
) -> dict[str, Any]:
    """Read one regular, unsharded Zarr v3 chunk and report absent chunks explicitly."""
    if (
        not isinstance(chunk_indices, list)
        or not chunk_indices
        or len(chunk_indices) > MAX_ARRAY_RANK
        or any(type(index) is not int or index < 0 for index in chunk_indices)
    ):
        raise DataReadError("INVALID_CHUNK_INDICES", f"chunk_indices must contain 1 to {MAX_ARRAY_RANK} non-negative integers.")

    try:
        root = paths.workspace_entry(path)
    except SecurityBoundaryError as exc:
        raise DataReadError(exc.code, str(exc)) from exc
    if not root.is_dir():
        raise DataReadError("ARRAY_STORE_NOT_DIRECTORY", "A Zarr array must be a local directory store inside the workspace.")
    root_relative = root.relative_to(paths.workspace).as_posix()
    metadata_relative = f"{root_relative}/zarr.json" if root_relative else "zarr.json"
    try:
        metadata_path = paths.workspace_file(metadata_relative, max_bytes=4 * 1024 * 1024)
        metadata_bytes = read_bytes_bounded(metadata_path, 4 * 1024 * 1024)
    except (ValueError, SecurityBoundaryError, OSError) as exc:
        code = getattr(exc, "code", "ZARR_METADATA_UNAVAILABLE")
        if code == "FILE_NOT_FOUND":
            legacy_metadata = f"{root_relative}/.zarray" if root_relative else ".zarray"
            try:
                paths.workspace_file(legacy_metadata, max_bytes=4 * 1024 * 1024)
            except SecurityBoundaryError:
                pass
            else:
                raise DataReadError("ZARR_FORMAT_UNSUPPORTED", "This reader currently supports Zarr v3 arrays only; the store uses v2 metadata.") from exc
        raise DataReadError(code, "The root Zarr v3 array metadata is missing, unreadable, or outside the workspace boundary.") from exc
    metadata_sha256 = hashlib.sha256(metadata_bytes).hexdigest()
    if expected_metadata_sha256 is not None:
        if len(expected_metadata_sha256) != 64 or any(char not in "0123456789abcdef" for char in expected_metadata_sha256):
            raise DataReadError("INVALID_METADATA_HASH", "expected_metadata_sha256 must be a lowercase SHA-256 value.")
        if expected_metadata_sha256 != metadata_sha256:
            raise DataReadError("SOURCE_CHANGED", "The array metadata changed between chunk reads; restart paging from the current metadata hash.")

    try:
        import numpy as np
        import zarr
    except ImportError as exc:
        raise DataReadError("ZARR_READER_UNAVAILABLE", "Install the optional proto-agent[data-read] dependencies on Python 3.12 or later to read Zarr arrays.") from exc

    try:
        array = zarr.open_array(root, mode="r")
    except Exception as exc:
        raise DataReadError("ZARR_METADATA_INVALID", f"The local store is not a readable root Zarr array ({type(exc).__name__}).") from exc
    if int(array.metadata.zarr_format) != 3:
        raise DataReadError("ZARR_FORMAT_UNSUPPORTED", "This reader currently supports Zarr v3 arrays only.")
    grid = array.metadata.chunk_grid
    if "regular" not in type(grid).__name__.lower():
        raise DataReadError("ZARR_CHUNK_GRID_UNSUPPORTED", "Rectilinear or other non-regular chunk grids are not supported by this reader.")
    codecs = getattr(array.metadata, "codecs", ())
    if any(
        "shard" in str(getattr(codec, "name", type(codec).__name__)).lower()
        for codec in codecs
    ):
        raise DataReadError("ZARR_SHARDING_UNSUPPORTED", "Sharded Zarr storage is not supported by this bounded single-chunk reader.")

    shape = tuple(int(value) for value in array.shape)
    chunks = tuple(int(value) for value in array.chunks)
    if len(shape) != len(chunk_indices) or len(chunks) != len(shape):
        raise DataReadError("CHUNK_RANK_MISMATCH", f"The array has rank {len(shape)} but {len(chunk_indices)} chunk indices were supplied.")
    if any(index * chunks[axis] >= shape[axis] for axis, index in enumerate(chunk_indices)):
        raise DataReadError("CHUNK_INDEX_OUT_OF_RANGE", "At least one requested chunk index is outside the array shape.")

    dtype = np.dtype(array.dtype)
    if dtype.fields is not None or dtype.subdtype is not None or dtype.kind not in "biufcmMSU":
        raise DataReadError("ZARR_DTYPE_UNSUPPORTED", f"The array dtype {dtype} is not in the supported scalar dtype set.")
    if (dtype.kind == "f" and dtype.itemsize > 8) or (dtype.kind == "c" and dtype.itemsize > 16):
        raise DataReadError("ARRAY_DTYPE_PRECISION_UNSUPPORTED", f"The array dtype {dtype} exceeds the JSON-safe floating-point precision boundary.")
    if dtype.itemsize == 0:
        raise DataReadError("ZARR_VARIABLE_WIDTH_DTYPE_UNSUPPORTED", f"The variable-width array dtype {dtype} has no safe decoded-size estimate for this reader.")
    actual_shape = tuple(min(chunks[axis], shape[axis] - chunk_indices[axis] * chunks[axis]) for axis in range(len(shape)))
    element_count = math.prod(actual_shape)
    decoded_bytes = element_count * int(dtype.itemsize)
    if element_count > MAX_ARRAY_CHUNK_ELEMENTS or decoded_bytes > MAX_ARRAY_CHUNK_BYTES:
        raise DataReadError(
            "ARRAY_CHUNK_TOO_LARGE",
            f"The requested chunk has {element_count} elements and an estimated {decoded_bytes} decoded bytes; use a smaller-chunk source or a later sub-chunk reader.",
        )

    encoding = array.metadata.chunk_key_encoding
    encode_chunk_key = getattr(encoding, "encode_chunk_key", None)
    if not callable(encode_chunk_key):
        raise DataReadError("ZARR_CHUNK_ENCODING_UNSUPPORTED", "The array uses an unsupported chunk-key encoding.")
    chunk_key = str(encode_chunk_key(tuple(chunk_indices)))
    key_parts = chunk_key.split("/")
    if not chunk_key or "\\" in chunk_key or any(part in {"", ".", ".."} for part in key_parts) or chunk_key.startswith("/") or any(":" in part for part in key_parts):
        raise DataReadError("ZARR_CHUNK_KEY_INVALID", "The Zarr metadata produced an invalid chunk key.")
    chunk_file = root / Path(*chunk_key.split("/"))
    try:
        relative_chunk = chunk_file.relative_to(paths.workspace).as_posix()
        safe_chunk = paths.workspace_file(relative_chunk, max_bytes=MAX_ARRAY_CHUNK_BYTES)
    except (ValueError, SecurityBoundaryError) as exc:
        if getattr(exc, "code", "") == "FILE_NOT_FOUND":
            return {
                "ok": True,
                "kind": "array_chunk",
                "format": "zarr-v3",
                "source": path,
                "metadata_sha256": metadata_sha256,
                "chunk_indices": chunk_indices,
                "chunk_key": chunk_key,
                "status": "missing_chunk",
                "values": None,
                "note": "Missing chunks are reported as unavailable; the Zarr fill value is not substituted.",
            }
        raise DataReadError(getattr(exc, "code", "CHUNK_PATH_INVALID"), "The requested chunk is outside the workspace or failed path validation.") from exc
    try:
        chunk_bytes = read_bytes_bounded(safe_chunk, MAX_ARRAY_CHUNK_BYTES)
    except SecurityBoundaryError as exc:
        raise DataReadError(exc.code, str(exc)) from exc
    chunk_sha256 = hashlib.sha256(chunk_bytes).hexdigest()

    read_array = array.with_config({"read_missing_chunks": False})
    starts = tuple(chunk_indices[axis] * chunks[axis] for axis in range(len(shape)))
    slices = tuple(slice(starts[axis], starts[axis] + actual_shape[axis]) for axis in range(len(shape)))
    try:
        values = read_array[slices]
    except Exception as exc:
        raise DataReadError(
            "ZARR_CHUNK_UNREADABLE",
            f"The present chunk at {chunk_indices} could not be decoded; it is reported as unreadable rather than filled ({type(exc).__name__}).",
        ) from exc

    try:
        metadata_after = read_bytes_bounded(metadata_path, 4 * 1024 * 1024)
        chunk_after = read_bytes_bounded(safe_chunk, MAX_ARRAY_CHUNK_BYTES)
    except SecurityBoundaryError as exc:
        raise DataReadError("SOURCE_CHANGED", "The selected array metadata or chunk changed while being read; discard this result.") from exc
    if hashlib.sha256(metadata_after).hexdigest() != metadata_sha256 or hashlib.sha256(chunk_after).hexdigest() != chunk_sha256:
        raise DataReadError("SOURCE_CHANGED", "The selected array metadata or chunk changed while being read; discard this result.")

    if dtype.kind == "M":
        json_values = np.datetime_as_string(values, unit="auto").tolist()
    elif dtype.kind == "m":
        json_values = np.timedelta_as_string(values, unit="auto").tolist()
    else:
        json_values = _array_value(values)
    page_sha256 = _sha256_json(json_values)
    payload = {
        "ok": True,
        "kind": "array_chunk",
        "format": "zarr-v3",
        "source": path,
        "metadata_sha256": metadata_sha256,
        "chunk_indices": chunk_indices,
        "chunk_key": chunk_key,
        "element_start": list(starts),
        "shape": list(actual_shape),
        "dtype": str(dtype),
        "status": "present",
        "source_chunk_sha256": chunk_sha256,
        "values": json_values,
        "page_sha256": page_sha256,
        "page_hash_scope": "canonical JSON for the returned chunk values only",
    }
    _enforce_response_budget(payload, MAX_PAGE_RESPONSE_BYTES)
    return payload


def _require_int(value: Any, name: str, *, minimum: int, maximum: int | None = None) -> None:
    if type(value) is not int or value < minimum or (maximum is not None and value > maximum):
        suffix = f" and at most {maximum}" if maximum is not None else ""
        raise DataReadError("INVALID_PAGE_ARGUMENT", f"{name} must be an integer of at least {minimum}{suffix}.")


def _file_identity(path: Path) -> tuple[int, int, int, int]:
    info = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise DataReadError("DATA_FILE_NOT_REGULAR", "Only single-link regular files can be read as Parquet tables.")
    return int(info.st_size), int(info.st_mtime_ns), int(getattr(info, "st_ino", 0)), int(info.st_dev)


def _source_version(identity: tuple[int, int, int, int]) -> str:
    return ":".join(str(value) for value in identity)


def _check_cancelled(cancel_event: Any) -> None:
    if cancel_event is not None and callable(getattr(cancel_event, "is_set", None)) and cancel_event.is_set():
        raise DataReadError("DATA_READ_CANCELLED", "The bounded data read was cancelled before the next row group.")


def _arrow_value(scalar: Any, arrow_type: Any, pa: Any) -> Any:
    if not scalar.is_valid:
        return None
    temporal = (
        pa.types.is_timestamp(arrow_type)
        or pa.types.is_duration(arrow_type)
        or pa.types.is_date32(arrow_type)
        or pa.types.is_date64(arrow_type)
        or pa.types.is_time32(arrow_type)
        or pa.types.is_time64(arrow_type)
    )
    if temporal:
        return scalar.cast(pa.string()).as_py()
    value = scalar.as_py()
    if value is None or type(value) in (str, bool):
        return value
    if isinstance(value, int):
        return value if abs(value) <= 9_007_199_254_740_991 else str(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, float):
        if math.isfinite(value):
            return value
        return {"$float": "NaN" if math.isnan(value) else ("Infinity" if value > 0 else "-Infinity")}
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"$binary_base64": base64.b64encode(bytes(value)).decode("ascii")}
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    raise DataReadError("ARROW_SCALAR_UNSUPPORTED", f"A value of type {type(value).__name__} cannot be serialized without losing its type.")


def _array_value(value: Any) -> Any:
    if hasattr(value, "tolist"):
        return _array_value(value.tolist())
    if isinstance(value, list):
        return [_array_value(item) for item in value]
    if isinstance(value, tuple):
        return [_array_value(item) for item in value]
    if value is None or type(value) in (str, bool):
        return value
    if isinstance(value, int):
        return value if abs(value) <= 9_007_199_254_740_991 else str(value)
    if isinstance(value, float):
        if math.isfinite(value):
            return value
        return {"$float": "NaN" if math.isnan(value) else ("Infinity" if value > 0 else "-Infinity")}
    if isinstance(value, complex):
        return {"$complex": {"real": _array_value(value.real), "imag": _array_value(value.imag)}}
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"$binary_base64": base64.b64encode(bytes(value)).decode("ascii")}
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    raise DataReadError("ARRAY_VALUE_UNSUPPORTED", f"A value of type {type(value).__name__} cannot be serialized without losing its type.")


def _sha256_json(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _enforce_response_budget(payload: dict[str, Any], max_bytes: int) -> None:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(encoded) > max_bytes:
        raise DataReadError(
            "DATA_PAGE_RESPONSE_TOO_LARGE",
            f"The complete page would be {len(encoded)} bytes; the response limit is {max_bytes}. Nothing was clipped or returned.",
        )
