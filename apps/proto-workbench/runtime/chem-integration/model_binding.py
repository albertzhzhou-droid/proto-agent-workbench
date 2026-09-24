"""Bind the unchanged Chem proposal controller to the user-selected local baseline.

This adapter only reads LM Studio's native inventory. It never loads a model,
grants approvals, substitutes variants or changes the scientific controller.
"""
from __future__ import annotations

from typing import Any, Callable

BASELINE_KEY = "unsloth/qwen3.8-27b"
BASELINE_QUANTIZATION = "Q4_K_M"
BASELINE_LABEL = "Qwen 3.8 27B Q4_K_M"


def baseline_model_status(local_request: Callable[..., dict[str, Any]]) -> dict[str, Any]:
    status: dict[str, Any] = {
        "available": False,
        "installed": None,
        "server_reachable": False,
        "key": BASELINE_KEY,
        "display_name": BASELINE_LABEL,
        "model_id": None,
        "endpoint": "http://127.0.0.1:1234",
        "mode": "strict_json_actions",
        "state": "unreachable",
    }
    try:
        inventory = local_request("/api/v1/models")
        status["server_reachable"] = True
        if not isinstance(inventory, dict) or not isinstance(inventory.get("models"), list):
            raise ValueError("INVALID_MODEL_INVENTORY: expected the native LM Studio model list")
        models = inventory["models"]
        if any(not isinstance(model, dict) for model in models):
            raise ValueError("INVALID_MODEL_INVENTORY: invalid model entry")
        matching = [model for model in models if model.get("key") == BASELINE_KEY]
        status.update(installed=False, state="missing")
        if not matching:
            status["message"] = f"{BASELINE_LABEL} is not in the LM Studio inventory"
            return status
        status["installed"] = True
        eligible = []
        for model in matching:
            quantization = model.get("quantization")
            quantization_name = quantization.get("name") if isinstance(quantization, dict) else quantization
            if quantization_name == BASELINE_QUANTIZATION:
                eligible.append(model)
        if len(eligible) != 1:
            status.update(state="variant_mismatch" if not eligible else "ambiguous", message="Select the exact unsloth Qwen 3.8 27B Q4_K_M variant in LM Studio; no alternative variant will be used.")
            return status
        model = eligible[0]
        instances = model.get("loaded_instances", [])
        if not isinstance(instances, list) or any(
            not isinstance(instance, dict)
            or not isinstance(instance.get("id"), str)
            or not instance["id"].strip()
            or len(instance["id"]) > 1024
            for instance in instances
        ):
            raise ValueError("INVALID_MODEL_INVENTORY: invalid loaded instances")
        instance = instances[0] if instances else None
        status.update(
            available=bool(instance),
            state="loaded" if instance else "unloaded",
            model_id=instance["id"] if instance else None,
            quantization=model.get("quantization"),
            variant=model.get("selected_variant"),
            loaded_config=instance.get("config") if instance else None,
            message="Ready" if instance else f"Load {BASELINE_LABEL} in LM Studio",
        )
        return status
    except (ValueError, TypeError, OSError) as error:
        status.update(available=False, installed=None, model_id=None, state="invalid_inventory" if status["server_reachable"] else "unreachable", message=str(error))
        return status


def install_model_binding(orchestrator: Any) -> None:
    # web imports this function by name. Install before importing web so both
    # its status endpoint and Design's controller consult the same live reader.
    orchestrator.MODEL_KEY = BASELINE_KEY
    orchestrator.model_status = lambda: baseline_model_status(orchestrator.local_request)
