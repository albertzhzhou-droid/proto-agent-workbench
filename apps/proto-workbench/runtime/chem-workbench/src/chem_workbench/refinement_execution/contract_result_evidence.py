"""Staged actual-byte execution evidence admission; never dispatch or retrospective proof.

HostContext and its bracket references must come from the trusted supervisor.
The injected reader enforces actual path/reparse containment and bounded reads.
No callback can replace missing retained bytes or a missing observer summary.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import PurePosixPath, PureWindowsPath
from typing import Any

from chem_workbench.refinement_execution.native_dispersion_records import (
    number,
    parse,
    require,
    same,
    validate_call,
)
from chem_workbench.refinement_execution.native_options import schema_matches, validate_entry

Record = dict[str, Any]
Reader = Callable[[Record], bytes]
ContractValidator = Callable[[object, object, str], Record]
ScientificValidator = Callable[[object, object], Record]
OptimizerValidator = Callable[[Record, Record, Record, bytes], None]
VERSION = "refinement-execution-evidence/v1"
COUNTS = {
    "qce_calls_seen",
    "qce_calls_forwarded",
    "qce_calls_returned",
    "inner_calls_seen",
    "inner_calls_forwarded",
    "inner_calls_returned",
}


@dataclass(frozen=True, kw_only=True)
class HostContext:
    run_id: str
    run_nonce: str
    run_directory: str
    worker_identity: Record
    source_identity: dict[str, str]
    native_task_config: Record
    native_dispersion_version: str
    host_before: Record
    host_after: Record


def digest(value: object) -> str:
    raw = json.dumps(value, allow_nan=False, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def closed(value: object, keys: set[str], label: str) -> Record:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError("closed " + label + " required")
    return dict(value)


def reference(value: object) -> Record:
    ref = closed(value, {"path", "sha256"}, "raw artifact reference")
    path = ref["path"]
    require(
        isinstance(path, str)
        and bool(path)
        and ":" not in path
        and "\\" not in path
        and not path.startswith("/")
        and all(p not in {"", ".", ".."} for p in path.split("/")),
        "artifact path",
    )
    require(
        isinstance(ref["sha256"], str) and re.fullmatch("[0-9a-f]{64}", ref["sha256"]) is not None,
        "raw hash",
    )
    return ref


class EvidenceAssessment:
    def __init__(self, context: HostContext, reader: Reader):
        self.context = context
        self.reader = reader
        self.errors: list[str] = []
        self.observations: list[Record] = []
        self.evaluations: list[Record] = []
        self.dispatch_observations: list[Record] = []
        self.cache: dict[str, tuple[Record, bytes]] = {}
        self.manifest: dict[str, Record] = {}
        self.used: set[str] = set()
        self.outer_counts = {
            "starts_read": 0,
            "returns_read": 0,
            "exceptions_read": 0,
            "successful_frames_bound": 0,
        }
        self.before = 0.0
        self.after = 0.0

    def error(self, label: str, error: Exception) -> None:
        self.errors.append(label + ": " + type(error).__name__ + ": " + str(error)[:800])

    def read(self, value: object, *, owned: bool = False) -> bytes:
        ref = reference(value)
        key = ref["path"].casefold()
        if owned:
            prefix = self.context.run_directory.casefold().rstrip("/") + "/"
            require(key.startswith(prefix), "call artifact outside current owned run")
        if key in self.cache:
            same(ref, self.cache[key][0], "same-path reference")
            return self.cache[key][1]
        raw = self.reader(dict(ref))
        require(type(raw) is bytes and len(raw) <= 20 * 1024**2, "bounded actual bytes required")
        actual = hashlib.sha256(raw).hexdigest()
        self.observations.append({"reference": ref, "observed_sha256": actual, "bytes": len(raw)})
        require(actual == ref["sha256"], "actual bytes/hash mismatch: " + ref["path"])
        self.cache[key] = (ref, raw)
        return raw

    def call_raw(self, ref: object) -> bytes:
        checked = reference(ref)
        key = checked["path"].casefold()
        require(key in self.manifest, "call artifact absent from independent host inventory")
        same(checked, self.manifest[key], "host-inventoried call artifact")
        self.used.add(key)
        return self.read(checked, owned=True)

    def bracket(self, contract: Record, spec: Record) -> None:
        context = self.context
        require(re.fullmatch("[A-Za-z0-9_.-]{1,120}", context.run_id) is not None, "run ID")
        require(re.fullmatch("[0-9a-f]{32,128}", context.run_nonce) is not None, "host run nonce")
        reference({"path": context.run_directory + "/owned", "sha256": "a" * 64})
        require(context.worker_identity.get("kind") == "psi4_refinement", "host worker kind")
        require(bool(context.source_identity), "complete host source identity required")
        require(bool(context.native_dispersion_version), "observed dispersion runtime version")
        config = closed(
            context.native_task_config,
            {"retries", "ncores", "memory", "scratch_directory"},
            "native task config",
        )
        require(type(config["retries"]) is int and config["retries"] == 0, "zero native retries")
        require(
            type(config["ncores"]) is int and config["ncores"] == spec["resources"]["threads"],
            "bound native threads",
        )
        require(
            0 < number(config["memory"]) <= spec["resources"]["memory_bytes"] / 1024**3,
            "native memory within approved worker ceiling",
        )
        require(
            isinstance(config["scratch_directory"], str)
            and PureWindowsPath(config["scratch_directory"]).is_absolute(),
            "native scratch",
        )
        common = {
            "version": "refinement-observer-host-bracket/v1",
            "run_id": context.run_id,
            "run_nonce": context.run_nonce,
            "spec_hash": spec["spec_hash"],
            "contract_hash": contract["contract_hash"],
            "worker_identity": context.worker_identity,
            "source_identity": context.source_identity,
            "runtime_binding_hash": spec["runtime_binding"]["binding_hash"],
            "basis_binding_hash": spec["basis_binding"]["binding_hash"],
            "native_task_config": context.native_task_config,
            "native_dispersion_version": context.native_dispersion_version,
        }
        for phase, ref in (("before", context.host_before), ("after", context.host_after)):
            record = parse(self.read(ref, owned=True))
            closed(
                record,
                set(common) | {"phase", "monotonic_seconds", "call_artifacts"},
                "host bracket",
            )
            same({k: record[k] for k in common}, common, "independent host context")
            require(record["phase"] == phase, "host bracket phase")
            clock = float(number(record["monotonic_seconds"]))
            require(clock > 0, "host monotonic clock")
            if phase == "before":
                self.before = clock
                require(
                    record["call_artifacts"] == [],
                    "run already contained call artifacts before launch",
                )
            else:
                self.after = clock
                require(
                    type(record["call_artifacts"]) is list
                    and len(record["call_artifacts"]) <= 200000,
                    "bounded host call inventory",
                )
                for item in record["call_artifacts"]:
                    item = reference(item)
                    key = item["path"].casefold()
                    require(key not in self.manifest, "duplicate host inventory path")
                    self.manifest[key] = item
                    self.read(item, owned=True)
        require(self.before < self.after, "host time bracket ordering")
        for path, sha256 in context.source_identity.items():
            self.read({"path": path, "sha256": sha256})

        # Actual bytes for every directly declared spec artifact, including runtime manifests.
        def artifacts(value: object) -> None:
            if isinstance(value, dict):
                if {"path", "sha256"} <= set(value):
                    self.read({key: value[key] for key in ("path", "sha256")})
                for item in value.values():
                    artifacts(item)
            elif isinstance(value, list):
                for item in value:
                    artifacts(item)

        artifacts(spec)

    def event(self, value: Record, evaluation_id: str, spec_hash: str) -> float:
        require(
            value.get("evaluation_id") == evaluation_id and value.get("spec_hash") == spec_hash,
            "observer evaluation/spec binding",
        )
        clock = float(number(value.get("monotonic_seconds")))
        require(self.before <= clock <= self.after, "event outside actual host run bracket")
        return clock

    def evaluation_config(self, index: int) -> Record:
        config = dict(self.context.native_task_config)
        config["scratch_directory"] = str(
            PureWindowsPath(config["scratch_directory"]) / f"evaluation-{index:04d}"
        )
        return config

    def dispatch(self, entry: Record, spec: Record, contract: Record) -> None:
        ref = reference(entry["dispatch_observation"])
        directory = PurePosixPath(ref["path"]).parent.as_posix()
        require(
            PurePosixPath(ref["path"]).name == "dispatch-observation.json",
            "actual dispatch observation filename",
        )
        require(entry["observer_directory"] == directory + "/nested", "dispatch/nested ownership")
        record = parse(self.call_raw(ref))
        keys = {"evaluation_id", "artifacts", "outer_forwarded", "nested_summary_present"}
        if record.get("nested_summary_present") is True:
            keys.add("nested_summary")
        closed(record, keys, "actual dispatch observation")
        require(record["evaluation_id"] == entry["evaluation_id"], "dispatch evaluation binding")
        artifacts = record["artifacts"]
        require(type(artifacts) is list and len(artifacts) <= 64, "bounded dispatch inventory")
        files: dict[str, Record] = {}
        for item in artifacts:
            closed(item, {"path", "sha256", "bytes"}, "dispatcher artifact")
            raw_ref = {key: item[key] for key in ("path", "sha256")}
            require(
                PurePosixPath(item["path"]).parent.as_posix() == directory,
                "dispatcher artifact directory",
            )
            name = PurePosixPath(item["path"]).name
            require(name not in files, "duplicate dispatch artifact")
            raw = self.call_raw(raw_ref)
            require(type(item["bytes"]) is int and item["bytes"] == len(raw), "dispatch byte count")
            files[name] = raw_ref
        actual = {
            PurePosixPath(item["path"]).name
            for item in self.manifest.values()
            if PurePosixPath(item["path"]).parent.as_posix() == directory
        }
        same(
            sorted(actual),
            sorted(set(files) | {"dispatch-observation.json"}),
            "complete dispatcher direct-child inventory",
        )
        observed: Record = {
            "evaluation_id": entry["evaluation_id"],
            "reference": ref,
            "record": record,
            "native_controls": {},
            "forwarded_input_changed": None,
            "complete": False,
        }
        self.dispatch_observations.append(observed)
        for name, field in (
            ("outer-input.json", "outer_request"),
            ("outer-start.json", "outer_start"),
            ("outer-result.json", "outer_return"),
            ("outer-exception.json", "outer_exception"),
        ):
            if entry[field] is not None:
                same(files.get(name), entry[field], "dispatcher/evaluation reference " + field)
        require(
            record["outer_forwarded"] is True and record["nested_summary_present"] is True,
            "dispatch was not forwarded or nested summary is missing",
        )
        nested = closed(
            record["nested_summary"], {"path", "sha256", "bytes"}, "dispatch nested summary"
        )
        same(
            {key: nested[key] for key in ("path", "sha256")},
            entry["observer_summary"],
            "dispatch/nested summary reference",
        )
        require(
            type(nested["bytes"]) is int
            and nested["bytes"] == len(self.call_raw(entry["observer_summary"])),
            "nested summary bytes",
        )
        controls = parse(self.call_raw(files["outer-dispatch-controls.json"]))
        closed(
            controls,
            {
                "requested_task_config",
                "forwarded_task_config",
                "return_version",
                "program",
                "raise_error",
            },
            "outer dispatch controls",
        )
        same(
            controls["requested_task_config"],
            self.context.native_task_config,
            "requested root controls",
        )
        effective = self.evaluation_config(entry["attempt_index"])
        same(controls["forwarded_task_config"], effective, "forwarded evaluation controls")
        require(
            controls["program"] == "psi4"
            and controls["raise_error"] is False
            and type(controls["return_version"]) is int
            and controls["return_version"] == 1,
            "actual outer return/error contract",
        )
        for phase in ("before", "after"):
            current = parse(self.call_raw(files["native-controls-" + phase + ".json"]))
            observed["native_controls"][phase] = current
            closed(
                current, {"stage", "threads", "memory_bytes", "scratch"}, "actual native controls"
            )
            require(
                current["stage"] == phase
                and type(current["threads"]) is int
                and current["threads"] == effective["ncores"],
                "actual native threads",
            )
            require(
                type(current["memory_bytes"]) is int
                and current["memory_bytes"] == int(effective["memory"] * 1024**3),
                "actual native memory",
            )
            require(
                isinstance(current["scratch"], str)
                and PureWindowsPath(current["scratch"])
                == PureWindowsPath(effective["scratch_directory"]),
                "actual native scratch",
            )
        forwarded_after = self.call_raw(files["outer-forwarded-input-after.json"])
        parse(
            forwarded_after
        )  # Preserve legitimate native mutation; do not replace original input.
        observed["forwarded_input_changed"] = forwarded_after != self.call_raw(
            entry["outer_request"]
        )
        binding = {
            "run_id": self.context.run_id,
            "run_nonce": self.context.run_nonce,
            "evaluation_id": entry["evaluation_id"],
            "spec_hash": spec["spec_hash"],
            "contract_hash": contract["contract_hash"],
            "outer_input_sha256": entry["outer_request"]["sha256"],
        }
        schema_raw = self.call_raw(files["native-schema-input.json"])
        schema_sha = hashlib.sha256(schema_raw).hexdigest()
        outer = parse(self.call_raw(entry["outer_request"]))
        schema_matches(parse(schema_raw), outer)
        schema_start = parse(self.call_raw(files["native-schema-start.json"]))
        start_expected = {
            **binding,
            "version": "refinement-native-schema-start/v1",
            "schema_input_sha256": schema_sha,
            "clean": True,
            "postclean": False,
        }
        closed(schema_start, set(start_expected) | {"monotonic_seconds"}, "native schema start")
        same(
            {key: schema_start[key] for key in start_expected},
            start_expected,
            "native schema start binding",
        )
        native_entry = parse(self.call_raw(files["native-gradient-entry.json"]))
        validate_entry(native_entry, binding=binding, outer=outer, schema_sha256=schema_sha)
        schema_time = self.event(schema_start, entry["evaluation_id"], spec["spec_hash"])
        gradient_time = self.event(native_entry, entry["evaluation_id"], spec["spec_hash"])
        outer_start = parse(self.call_raw(entry["outer_start"]))
        require(
            outer_start["monotonic_seconds"] <= schema_time <= gradient_time,
            "native entry ordering",
        )
        summary = parse(self.call_raw(files["native-schema-observation.json"]))
        summary_expected = {
            **binding,
            "version": "refinement-native-schema-observation/v1",
            "counts": {
                key: 1
                for key in (
                    "schema_seen",
                    "schema_forwarded",
                    "schema_returned",
                    "gradient_seen",
                    "gradient_forwarded",
                    "gradient_returned",
                )
            },
            "restoration_errors": [],
            "violations": [],
            "complete": True,
        }
        same(
            closed(summary, set(summary_expected), "native schema observation"),
            summary_expected,
            "complete actual schema/gradient calls",
        )
        observed["native_gradient_entry"] = native_entry
        observed["native_schema_observation"] = summary
        observed["complete"] = True

    def observer(
        self, entry: Record, spec: Record, frame: Record | None, outer_time: float
    ) -> None:
        directory = entry["observer_directory"]
        prefix = directory.casefold().rstrip("/") + "/"
        require(
            prefix.startswith(self.context.run_directory.casefold().rstrip("/") + "/"),
            "observer directory ownership",
        )
        refs = {
            PurePosixPath(ref["path"]).name: ref
            for key, ref in self.manifest.items()
            if key.startswith(prefix)
        }
        require(
            all(PurePosixPath(ref["path"]).parent.as_posix() == directory for ref in refs.values()),
            "observer inventory must be direct children",
        )
        counts = {key: 0 for key in COUNTS}
        for name, ref in refs.items():
            self.call_raw(ref)
            for layer in ("qce", "inner"):
                if re.fullmatch(layer + r"-\d{4}-start\.json", name):
                    counts[layer + "_calls_seen"] += 1
                if re.fullmatch(layer + r"-\d{4}-forwarded-request-after\.json", name):
                    counts[layer + "_calls_forwarded"] += 1
                if re.fullmatch(layer + r"-\d{4}-return\.json", name):
                    counts[layer + "_calls_returned"] += 1
        observation = {
            "evaluation_id": entry["evaluation_id"],
            "durable_counts": counts,
            "summary_declared_counts": None,
            "complete": False,
            "exception_artifacts": [ref for name, ref in refs.items() if "exception" in name],
        }
        self.evaluations.append(observation)
        require(
            entry["observer_summary"] is not None and "summary.json" in refs,
            "missing observer summary; unmatched starts remain partial",
        )
        same(entry["observer_summary"], refs["summary.json"], "observer summary ref")
        summary = parse(self.call_raw(entry["observer_summary"]))
        closed(
            summary,
            {
                "evaluation_id",
                "spec_hash",
                "monotonic_seconds",
                "version",
                "finalized",
                "context_exception",
                "restoration_errors",
                "counts",
                "artifacts",
                "scientific_accuracy_validated",
                "outer_electronic_attempts_observed",
            },
            "observer summary",
        )
        require(
            summary["scientific_accuracy_validated"] is False
            and summary["outer_electronic_attempts_observed"] is False,
            "nested observer cannot self-certify outer calls or scientific accuracy",
        )
        require(
            summary.get("version") == "nested-d3-observation-staged/v1"
            and summary.get("finalized") is True,
            "finalized observer version",
        )
        end = self.event(summary, entry["evaluation_id"], spec["spec_hash"])
        observation["summary_declared_counts"] = summary["counts"]
        expected_inventory = []
        for name, ref in refs.items():
            if name != "summary.json":
                expected_inventory.append(
                    {"name": name, "sha256": ref["sha256"], "bytes": len(self.call_raw(ref))}
                )
        actual_inventory = summary.get("artifacts")
        if not isinstance(actual_inventory, list):
            raise ValueError("observer inventory required")
        same(
            sorted(actual_inventory, key=lambda r: r["name"]),
            sorted(expected_inventory, key=lambda r: r["name"]),
            "complete observer inventory",
        )
        same(summary["counts"], counts, "durable and declared counters")
        require(
            summary["context_exception"] is None and summary["restoration_errors"] == [],
            "native context failure/restoration failure retained",
        )
        if frame is None:
            raise ValueError("failed outer attempt cannot complete an evaluation")
        same(counts, {key: 2 for key in COUNTS}, "one energy plus gradient and one inner call each")
        required = {"context-start.json", "summary.json"}
        for index in range(2):
            required |= {
                f"qce-{index:04d}-{part}.json"
                for part in (
                    "start",
                    "request",
                    "requested-config",
                    "forwarded-config",
                    "return",
                    "forwarded-request-after",
                )
            }
            required |= {
                f"inner-{index:04d}-{part}.json"
                for part in ("start", "request", "return", "forwarded-request-after")
            }
        same(sorted(refs), sorted(required), "exact completed call record set")
        start = parse(self.call_raw(refs["context-start.json"]))
        closed(
            start,
            {
                "evaluation_id",
                "spec_hash",
                "monotonic_seconds",
                "scratch_before",
                "scratch_forwarded",
                "ncores",
                "memory_gib",
                "nested_retries",
                "scope",
            },
            "observer context start",
        )
        begin = self.event(start, entry["evaluation_id"], spec["spec_hash"])
        require(outer_time <= begin <= end, "outer call/observer start/summary order")
        config = self.evaluation_config(entry["attempt_index"])
        require(
            type(start.get("nested_retries")) is int and start["nested_retries"] == 0,
            "context zero retries",
        )
        same(start["ncores"], config["ncores"], "context ncores")
        require(number(start["memory_gib"]) == number(config["memory"]), "context memory")
        require(
            PureWindowsPath(start["scratch_forwarded"])
            == PureWindowsPath(config["scratch_directory"]),
            "context scratch",
        )
        previous = begin
        for index, driver in enumerate(("energy", "gradient")):
            qce, inner = f"qce-{index:04d}", f"inner-{index:04d}"
            qstart = parse(self.call_raw(refs[qce + "-start.json"]))
            istart = parse(self.call_raw(refs[inner + "-start.json"]))
            closed(
                qstart, {"evaluation_id", "spec_hash", "monotonic_seconds", "program"}, "QCE start"
            )
            closed(
                istart,
                {"evaluation_id", "spec_hash", "monotonic_seconds", "parent_qce_call"},
                "inner start",
            )
            qt = self.event(qstart, entry["evaluation_id"], spec["spec_hash"])
            it = self.event(istart, entry["evaluation_id"], spec["spec_hash"])
            require(previous <= qt <= it <= end, "nested event ordering")
            previous = it
            require(
                qstart.get("program") == "s-dftd3" and istart.get("parent_qce_call") == qce,
                "nested program or parent linkage",
            )
            forwarded = parse(self.call_raw(refs[qce + "-forwarded-config.json"]))
            closed(forwarded, set(config), "forwarded native config")
            for key in ("retries", "ncores"):
                same(forwarded[key], config[key], "forwarded control " + key)
            require(number(forwarded["memory"]) == number(config["memory"]), "forwarded memory")
            require(
                isinstance(forwarded["scratch_directory"], str)
                and PureWindowsPath(forwarded["scratch_directory"])
                == PureWindowsPath(config["scratch_directory"]),
                "forwarded scratch differs",
            )
            requested_raw = self.call_raw(refs[qce + "-requested-config.json"])
            requested = None if requested_raw.strip() == b"null" else parse(requested_raw)
            require(requested is None or type(requested) is dict, "requested config type")
            for key, value in (requested or {}).items():
                require(key in config, "unknown requested config/local override")
                if key == "scratch_directory":
                    require(
                        isinstance(value, str)
                        and PureWindowsPath(value) == PureWindowsPath(config[key]),
                        "requested scratch differs",
                    )
                elif key == "memory":
                    require(number(value) == number(config[key]), "requested memory differs")
                else:
                    same(value, config[key], "requested control " + key)
            outer_raw = self.call_raw(refs[qce + "-request.json"])
            inner_raw = self.call_raw(refs[inner + "-request.json"])
            validate_call(
                outer_request=outer_raw,
                inner_request=inner_raw,
                outer_result=self.call_raw(refs[qce + "-return.json"]),
                inner_result=self.call_raw(refs[inner + "-return.json"]),
                spec=spec,
                geometry=frame["geometry"],
                driver=driver,
                native_version=self.context.native_dispersion_version,
            )
            same(
                parse(self.call_raw(refs[inner + "-forwarded-request-after.json"])),
                parse(inner_raw),
                "inner forwarded input after invocation",
            )
            outer_after = parse(self.call_raw(refs[qce + "-forwarded-request-after.json"]))
            require(
                digest(outer_after) in {digest(parse(outer_raw)), digest(parse(inner_raw))},
                "outer forwarded input changed beyond observed alias transformation",
            )
        observation["complete"] = True


def assess_contract_result(
    contract: Record,
    spec: Record,
    mode: str,
    result: Record,
    *,
    evidence_ref: Record,
    host_context: HostContext,
    read_artifact: Reader,
    validate_contract: ContractValidator,
    validate_scientific_result: ScientificValidator,
    validate_optimizer_evidence: OptimizerValidator | None,
) -> Record:
    assessment = EvidenceAssessment(host_context, read_artifact)
    envelope: Record | None = None
    try:
        same(validate_contract(contract, spec, mode), contract, "validated execution contract")
        same(validate_scientific_result(spec, result), result, "validated scientific result")
        envelope = parse(assessment.read(evidence_ref, owned=True))
        closed(
            envelope,
            {
                "version",
                "run_id",
                "run_nonce",
                "contract_hash",
                "spec_hash",
                "result_hash",
                "host_before",
                "host_after",
                "evaluations",
                "optimizer_evidence",
                "evidence_hash",
            },
            "execution evidence",
        )
        require(envelope["version"] == VERSION, "evidence version")
        same(
            envelope["evidence_hash"],
            digest({k: v for k, v in envelope.items() if k != "evidence_hash"}),
            "evidence content hash",
        )
        for key, expected in (
            ("run_id", host_context.run_id),
            ("run_nonce", host_context.run_nonce),
            ("contract_hash", contract["contract_hash"]),
            ("spec_hash", spec["spec_hash"]),
            ("result_hash", result["result_hash"]),
            ("host_before", host_context.host_before),
            ("host_after", host_context.host_after),
        ):
            same(envelope[key], expected, "current run binding " + key)
        assessment.bracket(contract, spec)
        entries = envelope["evaluations"]
        require(
            type(entries) is list
            and len(entries) <= spec["optimizer_settings"]["max_gradient_evaluations"],
            "bounded outer evaluation inventory",
        )
        frames = {frame["frame_hash"]: frame for frame in result["trajectory"]}
        seen_frames: list[str] = []
        ids: set[str] = set()
        for index, entry in enumerate(entries):
            try:
                closed(
                    entry,
                    {
                        "evaluation_id",
                        "attempt_index",
                        "frame_hash",
                        "outer_start",
                        "outer_request",
                        "outer_return",
                        "outer_exception",
                        "observer_directory",
                        "observer_summary",
                        "dispatch_observation",
                    },
                    "evaluation entry",
                )
                require(
                    type(entry["attempt_index"]) is int and entry["attempt_index"] == index,
                    "contiguous actual outer attempt index",
                )
                require(
                    isinstance(entry["evaluation_id"], str) and entry["evaluation_id"] not in ids,
                    "unique evaluation ID",
                )
                ids.add(entry["evaluation_id"])
                outer_start = parse(assessment.call_raw(entry["outer_start"]))
                expected_start = {
                    "version": "refinement-electronic-call-start/v1",
                    "run_id": host_context.run_id,
                    "run_nonce": host_context.run_nonce,
                    "evaluation_id": entry["evaluation_id"],
                    "spec_hash": spec["spec_hash"],
                    "contract_hash": contract["contract_hash"],
                    "program": "psi4",
                    "dispatch": contract["dispatch"],
                    "task_config": assessment.evaluation_config(index),
                    "input_sha256": entry["outer_request"]["sha256"],
                }
                closed(outer_start, set(expected_start) | {"monotonic_seconds"}, "electronic start")
                same(
                    {k: outer_start[k] for k in expected_start},
                    expected_start,
                    "actual electronic dispatch",
                )
                outer_time = assessment.event(
                    outer_start, entry["evaluation_id"], spec["spec_hash"]
                )
                assessment.outer_counts["starts_read"] += 1
                raw_input = assessment.call_raw(entry["outer_request"])
                outer_input = parse(raw_input)
                require(
                    outer_input.get("schema_name") == "qcschema_input"
                    and type(outer_input.get("schema_version")) is int
                    and outer_input["schema_version"] == 1
                    and outer_input.get("driver") == "gradient",
                    "analytic outer gradient schema",
                )
                same(
                    outer_input.get("keywords"),
                    spec["electronic_settings"]["native_keywords"],
                    "outer keywords",
                )
                same(
                    outer_input.get("model"),
                    {"method": spec["profile"]["method"], "basis": spec["profile"]["basis"]},
                    "outer electronic method/basis",
                )
                same(outer_input.get("extras"), {"psiapi": True}, "in-process Psiapi request")
                frame = frames.get(entry["frame_hash"])
                if entry["outer_return"] is not None:
                    raw_return = assessment.call_raw(entry["outer_return"])
                    assessment.outer_counts["returns_read"] += 1
                    if frame is not None:
                        require(
                            entry["outer_exception"] is None,
                            "successful frame has an outer exception",
                        )
                        require(
                            raw_input == frame["raw_input_json"].encode("utf-8")
                            and raw_return == frame["raw_result_json"].encode("utf-8"),
                            "original outer raw bytes differ from retained frame",
                        )
                        require(entry["frame_hash"] not in seen_frames, "reused completed frame")
                        seen_frames.append(entry["frame_hash"])
                        assessment.outer_counts["successful_frames_bound"] += 1
                if entry["outer_exception"] is not None:
                    assessment.call_raw(entry["outer_exception"])
                    assessment.outer_counts["exceptions_read"] += 1
                try:
                    assessment.dispatch(entry, spec, contract)
                except (ValueError, TypeError, KeyError, OSError, AttributeError) as error:
                    assessment.error("dispatcher " + str(index), error)
                assessment.observer(entry, spec, frame, outer_time)
                require(
                    frame is not None and entry["outer_return"] is not None,
                    "incomplete/failed electronic call remains partial",
                )
            except (ValueError, TypeError, KeyError, OSError, AttributeError) as error:
                assessment.error("evaluation " + str(index), error)
        same(
            seen_frames,
            [frame["frame_hash"] for frame in result["trajectory"]],
            "all actual frames in order",
        )
        require(
            type(result["timing"]["backend_attempts_observed"]) is int
            and len(entries) == result["timing"]["backend_attempts_observed"],
            "outer attempt accounting",
        )
        same(
            sorted(assessment.used),
            sorted(assessment.manifest),
            "all host-observed call artifacts disclosed",
        )
        if mode == "optimization":
            if envelope["optimizer_evidence"] is None or validate_optimizer_evidence is None:
                raise ValueError("authentic optimizer evidence and validator required")
            raw_optimizer = assessment.read(envelope["optimizer_evidence"], owned=True)
            validate_optimizer_evidence(contract, spec, result, raw_optimizer)
        else:
            require(envelope["optimizer_evidence"] is None, "gradient has no optimizer evidence")
        require(result["evidence_origin"] == "worker_record", "actual worker origin required")
        require(
            bool(entries) and len(assessment.evaluations) == len(entries),
            "complete nonempty nested inventory",
        )
    except (ValueError, TypeError, KeyError, OSError, AttributeError) as error:
        assessment.error("execution evidence", error)
    body = {
        "version": "refinement-execution-evidence-assessment/v1",
        "evidence_reference": evidence_ref,
        "run_id": host_context.run_id,
        "complete": not assessment.errors,
        "outer_entries_declared": len(envelope["evaluations"])
        if envelope is not None and isinstance(envelope.get("evaluations"), list)
        else None,
        "outer_observed_counts": assessment.outer_counts,
        "evaluations": assessment.evaluations,
        "dispatch_observations": assessment.dispatch_observations,
        "artifact_observations": assessment.observations,
        "errors": assessment.errors,
        "scientific_result_hash": result.get("result_hash"),
        "scientific_accuracy_validated": False,
        "minimum_certified": False,
        "note": "Failures are retained; missing observations are never inferred as zero attempts.",
    }
    return {**body, "assessment_hash": digest(body)}


def validate_contract_result(
    contract: Record,
    spec: Record,
    mode: str,
    result: Record,
    *,
    evidence_ref: Record,
    host_context: HostContext,
    read_artifact: Reader,
    validate_contract: ContractValidator,
    validate_scientific_result: ScientificValidator,
    validate_optimizer_evidence: OptimizerValidator | None,
) -> None:
    assessment = assess_contract_result(
        contract,
        spec,
        mode,
        result,
        evidence_ref=evidence_ref,
        host_context=host_context,
        read_artifact=read_artifact,
        validate_contract=validate_contract,
        validate_scientific_result=validate_scientific_result,
        validate_optimizer_evidence=validate_optimizer_evidence,
    )
    require(assessment["complete"] is True, "; ".join(assessment["errors"])[:2000])
