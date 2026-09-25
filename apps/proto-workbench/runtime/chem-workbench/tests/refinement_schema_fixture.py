"""Synthetic QCSchema lifecycle, explicitly no native imports or calculations."""

import copy
import json
from types import SimpleNamespace
from unittest.mock import patch

from chem_workbench.refinement_execution import native_options


def synthetic_native_trace(outer, binding, write, *, timestamp=110.0):
    """Run the real observer against a fake schema/driver, for byte-admission tests."""
    psi4 = SimpleNamespace(core=SimpleNamespace())
    schema = SyntheticSchema(psi4)
    request = SimpleNamespace(json=lambda: json.dumps(outer))
    with patch.object(native_options.time, "monotonic", return_value=timestamp):
        with native_options.NativeOptionsObserver(
            psi4=psi4, outer=outer, binding=binding, write=write
        ) as observer:
            schema.compute(request, lambda: None)
            observer.require_complete()


class SyntheticSchema:
    def __init__(self, psi4):
        self.psi4 = psi4
        self.in_gradient = False
        self.options = {}
        self.basis = ""
        self.callback = None
        self.before_gradient = lambda: None
        self.gradient_calls = 1
        self.skip_gradient = False
        self.last_input = None
        self.active_request = None
        self.schema_fault = None
        self.call_kwargs = {"postclean": False}
        self.gradient_kwargs = None
        self.method_override = None
        self.molecule_override = None
        self.global_changed = True
        self.local_changed = False
        self.local = {}
        self.input_version = 1
        psi4.core.get_option = lambda module, key: self.local.get(
            key.lower(), self.options[key.lower()]
        )
        psi4.core.get_global_option = lambda key: (
            self.basis if key == "BASIS" else self.options[key.lower()]
        )
        psi4.core.get_local_option = lambda module, key: self.local.get(
            key.lower(), self.options[key.lower()]
        )
        psi4.core.has_global_option_changed = lambda key: self.global_changed
        psi4.core.has_local_option_changed = lambda module, key: self.local_changed
        psi4.core.has_option_changed = lambda module, key: self.local_changed or self.global_changed
        gradient = self.gradient
        self.original_gradient = gradient
        self.original_schema = self.run_schema
        psi4.schema_wrapper = SimpleNamespace(
            run_qcschema=self.original_schema,
            methods_dict_={"gradient": gradient},
            driver=SimpleNamespace(gradient=gradient),
        )

    def compute(self, request, callback):
        self.callback = callback
        self.active_request = request
        if self.input_version == 2:
            raw = json.loads(request.json())
            body = {
                "schema_name": "qcschema_atomic_input",
                "schema_version": 2,
                "molecule": raw["molecule"],
                "specification": {
                    key: raw[key] for key in ("driver", "model", "keywords", "extras")
                },
            }
            request = SimpleNamespace(json=lambda: json.dumps(body))
        return self.psi4.schema_wrapper.run_qcschema(request, **self.call_kwargs)

    def gradient(self, method, **kwargs):
        self.in_gradient = True
        try:
            return self.callback(), None
        finally:
            self.in_gradient = False

    def run_schema(
        self,
        input_data,
        clean=True,
        postclean=True,
        *,
        return_dict=False,
        return_version=-1,
        _allow_v1_dict_shim=False,
    ):
        raw = input_data if isinstance(input_data, dict) else json.loads(input_data.json())
        self.last_input = copy.deepcopy(raw)
        native = raw.get("specification", raw)
        if clean:
            self.options.clear()
        self.options.update(
            {
                key: int(value)
                if type(value) is bool
                else value.upper()
                if isinstance(value, str)
                else value
                for key, value in native["keywords"].items()
                if key != "function_kwargs"
            }
        )
        self.basis = native["model"]["basis"].upper()
        self.before_gradient()
        if self.schema_fault:
            self.schema_fault()
        molecule = copy.deepcopy(raw["molecule"])
        if self.molecule_override:
            self.molecule_override(molecule)
        kwargs = {
            **native["keywords"]["function_kwargs"],
            "return_wfn": True,
            "molecule": SimpleNamespace(to_schema=lambda **kwargs: copy.deepcopy(molecule)),
        }
        if self.gradient_kwargs:
            kwargs.update(self.gradient_kwargs)
        method = self.method_override or native["model"]["method"]
        try:
            if self.skip_gradient:
                return self.callback()
            for _ in range(self.gradient_calls):
                value, _ = self.psi4.schema_wrapper.methods_dict_["gradient"](method, **kwargs)
            return value
        finally:
            if clean:
                self.options.update(
                    d_convergence=1e-6, e_convergence=1e-6, reference="RHF", scf_type="PK"
                )
