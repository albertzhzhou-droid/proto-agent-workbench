"""Observe the actual Psi4 schema-to-gradient boundary without setting options.

The hooks are scoped to one isolated serial worker call. They neither grant
execution authority nor replace the original schema or electronic driver.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import math
import time
from collections.abc import Callable
from types import TracebackType
from typing import Any

from chem_workbench.refinement_execution.nested_dispersion_observer import _raw_model
from chem_workbench.visualization import content_hash

Record = dict[str, Any]
Writer = Callable[[str, Any, bool], None]


def require(value: bool, label: str) -> None:
    if not value:
        raise ValueError("APPROVAL_STALE: native schema " + label)


def same(actual: Any, expected: Any, label: str) -> None:
    require(content_hash(actual) == content_hash(expected), label)


def option_matches(actual: Any, expected: Any) -> bool:
    if isinstance(expected, str):
        return isinstance(actual, str) and actual.casefold() == expected.casefold()
    if type(expected) is bool:
        return type(actual) is int and actual == int(expected)
    return type(actual) is type(expected) and actual == expected


def molecule_matches(actual: Record, expected: Record) -> None:
    """Bind the current submitted geometry, including an optimizer's later point."""
    for key in ("symbols", "atom_labels", "molecular_multiplicity", "fix_com", "fix_orientation"):
        same(actual.get(key), expected.get(key), "molecule " + key)
    require(actual.get("fix_com") is True and actual.get("fix_orientation") is True, "fixed frame")
    count = len(expected["symbols"])
    same(actual.get("real", [True] * count), expected.get("real", [True] * count), "real atoms")
    same(actual.get("mass_numbers"), expected.get("mass_numbers"), "mass numbers")
    # The geometry tolerance is the retained molecular contract's serialization
    # tolerance. Explicit isotope masses have no tolerance.
    for key, tolerance in (("geometry", 1e-7), ("masses", 0.0)):
        left, right = actual.get(key), expected.get(key)
        require(type(left) is list and type(right) is list and len(left) == len(right), key)
        assert isinstance(left, list) and isinstance(right, list)
        for a, b in zip(left, right, strict=True):
            require(
                type(a) in (int, float)
                and type(b) in (int, float)
                and math.isfinite(a)
                and math.isfinite(b)
                and abs(a - b) <= tolerance,
                key,
            )
    a, b = actual.get("molecular_charge"), expected.get("molecular_charge")
    require(type(a) in (int, float) and type(b) in (int, float) and a == b, "charge")


def schema_matches(value: Record, outer: Record) -> None:
    if (
        value.get("schema_name") == "qcschema_input"
        and type(value.get("schema_version")) is int
        and value["schema_version"] == 1
    ):
        specification = value
    else:
        require(
            value.get("schema_name") == "qcschema_atomic_input"
            and type(value.get("schema_version")) is int
            and value["schema_version"] == 2,
            "input version",
        )
        specification = value["specification"]
    for key in ("driver", "model", "keywords", "extras"):
        same(specification.get(key), outer.get(key), "input " + key)
    molecule_matches(value["molecule"], outer["molecule"])


def validate_entry(value: Record, *, binding: Record, outer: Record, schema_sha256: str) -> None:
    expected_keys = set(binding) | {
        "version",
        "schema_input_sha256",
        "method",
        "function_kwargs",
        "return_wfn",
        "molecule",
        "effective_options",
        "option_scopes",
        "global_basis",
        "monotonic_seconds",
    }
    require(set(value) == expected_keys, "closed gradient entry")
    same({key: value[key] for key in binding}, binding, "gradient entry binding")
    require(value["version"] == "refinement-native-gradient-entry/v1", "entry version")
    require(value["schema_input_sha256"] == schema_sha256, "entry input bytes")
    same(value["method"], outer["model"]["method"], "actual driver method")
    same(value["function_kwargs"], outer["keywords"]["function_kwargs"], "actual driver arguments")
    require(value["return_wfn"] is True, "actual return_wfn")
    require(option_matches(value["global_basis"], outer["model"]["basis"]), "actual basis")
    molecule_matches(value["molecule"], outer["molecule"])
    wanted = {k: v for k, v in outer["keywords"].items() if k != "function_kwargs"}
    require(set(value["effective_options"]) == set(wanted), "complete effective options")
    require(set(value["option_scopes"]) == set(wanted), "complete option scopes")
    for key, expected in wanted.items():
        require(
            option_matches(value["effective_options"][key], expected), "effective option " + key
        )
        scopes = value["option_scopes"][key]
        require(
            set(scopes) == {"global", "local", "global_changed", "local_changed", "used_changed"},
            "option scope fields",
        )
        for flag in ("global_changed", "local_changed", "used_changed"):
            require(type(scopes[flag]) is bool, "option changed flag")
        require(
            scopes["used_changed"] and (scopes["global_changed"] or scopes["local_changed"]),
            "explicit option " + key,
        )
        used = scopes["local"] if scopes["local_changed"] else scopes["global"]
        same(used, value["effective_options"][key], "resolved option scope " + key)
    stamp = value["monotonic_seconds"]
    require(type(stamp) in (int, float) and math.isfinite(stamp) and stamp >= 0, "entry time")


class NativeOptionsObserver:
    """Exactly one genuine schema call and its gradient entry; always restore hooks."""

    def __init__(self, *, psi4: Any, outer: Record, binding: Record, write: Writer):
        self.psi4, self.outer, self.binding, self.write = psi4, outer, binding, write
        self.schema = psi4.schema_wrapper
        self.original_schema = self.schema.run_qcschema
        self.methods = self.schema.methods_dict_
        self.original_gradient = self.methods["gradient"]
        require(
            callable(self.original_schema) and callable(self.original_gradient), "callable hooks"
        )
        require(self.original_gradient is self.schema.driver.gradient, "unwrapped genuine gradient")
        self.signature = inspect.signature(self.original_schema)
        self.counts = {
            name: 0
            for name in (
                "schema_seen",
                "schema_forwarded",
                "schema_returned",
                "gradient_seen",
                "gradient_forwarded",
                "gradient_returned",
            )
        }
        self.active_schema = False
        self.schema_sha256: str | None = None
        self.restoration_errors: list[str] = []
        self.violations: list[str] = []
        self.schema_hook = self._schema
        self.gradient_hook = self._gradient

    def __enter__(self) -> NativeOptionsObserver:
        self.schema.run_qcschema = self.schema_hook
        self.methods["gradient"] = self.gradient_hook
        return self

    def _check(self, condition: bool, label: str) -> None:
        if not condition:
            self.violations.append(label)
        require(condition, label)

    def _schema(self, input_data: Any, *args: Any, **kwargs: Any) -> Any:
        self.counts["schema_seen"] += 1
        self._check(
            self.counts["schema_seen"] == 1 and not self.active_schema, "schema invocation count"
        )
        call = self.signature.bind(input_data, *args, **kwargs)
        call.apply_defaults()
        self._check(
            call.arguments.get("clean") is True and call.arguments.get("postclean") is False,
            "cleanup policy",
        )
        raw = _raw_model(input_data)
        self.write("native-schema-input.json", raw, True)
        self.schema_sha256 = hashlib.sha256(raw.encode()).hexdigest()
        schema_matches(json.loads(raw), self.outer)
        self.write(
            "native-schema-start.json",
            {
                **self.binding,
                "version": "refinement-native-schema-start/v1",
                "schema_input_sha256": self.schema_sha256,
                "clean": True,
                "postclean": False,
                "monotonic_seconds": time.monotonic(),
            },
            False,
        )
        self.active_schema = True
        self.counts["schema_forwarded"] += 1
        try:
            result = self.original_schema(input_data, *args, **kwargs)
            self.counts["schema_returned"] += 1
            return result
        finally:
            self.active_schema = False

    def _gradient(self, method: Any, *args: Any, **kwargs: Any) -> Any:
        self.counts["gradient_seen"] += 1
        self._check(
            self.active_schema and self.counts["gradient_seen"] == 1,
            "gradient invocation count/context",
        )
        self._check(
            not args and set(kwargs) == {"molecule", "return_wfn", "dertype", "engine"},
            "closed gradient arguments",
        )
        wanted = {k: v for k, v in self.outer["keywords"].items() if k != "function_kwargs"}
        record = {
            **self.binding,
            "version": "refinement-native-gradient-entry/v1",
            "schema_input_sha256": self.schema_sha256,
            "method": method,
            "function_kwargs": {key: kwargs[key] for key in ("dertype", "engine")},
            "return_wfn": kwargs["return_wfn"],
            "molecule": kwargs["molecule"].to_schema(dtype=2, units="Bohr", quiet=True),
            "effective_options": {
                key: self.psi4.core.get_option("SCF", key.upper()) for key in wanted
            },
            "option_scopes": {
                key: {
                    "global": self.psi4.core.get_global_option(key.upper()),
                    "local": self.psi4.core.get_local_option("SCF", key.upper()),
                    "global_changed": self.psi4.core.has_global_option_changed(key.upper()),
                    "local_changed": self.psi4.core.has_local_option_changed("SCF", key.upper()),
                    "used_changed": self.psi4.core.has_option_changed("SCF", key.upper()),
                }
                for key in wanted
            },
            "global_basis": self.psi4.core.get_global_option("BASIS"),
            "monotonic_seconds": time.monotonic(),
        }
        # Retain what was actually read even when the value is inadmissible.
        self.write("native-gradient-entry.json", record, False)
        assert self.schema_sha256 is not None
        validate_entry(
            record, binding=self.binding, outer=self.outer, schema_sha256=self.schema_sha256
        )
        self.counts["gradient_forwarded"] += 1
        result = self.original_gradient(method, **kwargs)
        self.counts["gradient_returned"] += 1
        return result

    def require_complete(self) -> None:
        require(
            not self.violations and all(value == 1 for value in self.counts.values()),
            "missing/repeated completed gradient entry",
        )

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if self.schema.run_qcschema is not self.schema_hook:
            self.restoration_errors.append("schema hook replaced")
        if (
            self.schema.methods_dict_ is not self.methods
            or self.methods.get("gradient") is not self.gradient_hook
        ):
            self.restoration_errors.append("gradient hook replaced")
        if self.schema.driver.gradient is not self.original_gradient:
            self.restoration_errors.append("original gradient identity changed")
        self.schema.run_qcschema = self.original_schema
        self.schema.methods_dict_ = self.methods
        self.methods["gradient"] = self.original_gradient
        self.write(
            "native-schema-observation.json",
            {
                **self.binding,
                "version": "refinement-native-schema-observation/v1",
                "counts": self.counts,
                "restoration_errors": self.restoration_errors,
                "violations": self.violations,
                "complete": not self.restoration_errors
                and not self.violations
                and all(v == 1 for v in self.counts.values()),
            },
            False,
        )
        if self.restoration_errors:
            error = ValueError("APPROVAL_STALE: native schema hook identity changed")
            if exc is not None:
                exc.add_note(str(error))
            else:
                raise error
