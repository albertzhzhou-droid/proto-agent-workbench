"""Exact native-model binding; no model load or provider inference in these tests."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

MODULE = Path(__file__).resolve().parents[1] / "runtime/chem-integration/model_binding.py"
SPEC = importlib.util.spec_from_file_location("chem_model_binding", MODULE)
binding = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(binding)


def model(key=binding.BASELINE_KEY, quantization="Q4_K_M", instances=None):
    return {"key": key, "quantization": {"name": quantization}, "loaded_instances": instances or []}


class ModelBindingTests(unittest.TestCase):
    def status(self, models):
        return binding.baseline_model_status(lambda path: {"models": models})

    def test_missing_baseline_never_uses_other_models(self):
        status = self.status([model("google/gemma-4-e4b", instances=[{"id": "gemma"}]), model("qwen/qwen3.8-27b", "Q8_0", [{"id": "qwen-q8"}]), model("unsloth/qwen3.8-27b-obliterated", instances=[{"id": "other"}])])
        self.assertFalse(status["available"])
        self.assertFalse(status["installed"])
        self.assertEqual(status["state"], "missing")
        self.assertIsNone(status["model_id"])

    def test_installed_baseline_without_loaded_instance_is_unavailable(self):
        status = self.status([model()])
        self.assertFalse(status["available"])
        self.assertTrue(status["installed"])
        self.assertEqual(status["state"], "unloaded")

    def test_wrong_quantization_is_rejected_even_when_loaded(self):
        status = self.status([model(quantization="Q8_0", instances=[{"id": "q8"}])])
        self.assertFalse(status["available"])
        self.assertEqual(status["state"], "variant_mismatch")

    def test_live_instance_id_is_used_and_cleared_after_unload(self):
        models = [model(instances=[{"id": "actual-instance-id", "config": {"context_length": 32768}}])]
        reader = lambda path: {"models": models}
        loaded = binding.baseline_model_status(reader)
        self.assertTrue(loaded["available"])
        self.assertEqual(loaded["model_id"], "actual-instance-id")
        models[0]["loaded_instances"] = []
        unloaded = binding.baseline_model_status(reader)
        self.assertFalse(unloaded["available"])
        self.assertIsNone(unloaded["model_id"])

    def test_invalid_and_ambiguous_inventory_is_not_available(self):
        for models in ([model(), model()], [{**model(), "loaded_instances": [{"id": ""}]}], [None]):
            self.assertFalse(self.status(models)["available"])

    def test_unreachable_server_does_not_reuse_historical_inventory(self):
        def unavailable(path):
            raise ValueError("MODEL_UNAVAILABLE: server stopped")
        status = binding.baseline_model_status(unavailable)
        self.assertFalse(status["available"])
        self.assertFalse(status["server_reachable"])
        self.assertIsNone(status["installed"])

    def test_hook_only_replaces_the_provider_status_reader(self):
        action = object()
        module = SimpleNamespace(MODEL_KEY="google/gemma-4-e4b", request_action=action, local_request=lambda path: {"models": [model()]})
        binding.install_model_binding(module)
        self.assertEqual(module.MODEL_KEY, binding.BASELINE_KEY)
        self.assertIs(module.request_action, action)
        self.assertEqual(module.model_status()["display_name"], binding.BASELINE_LABEL)


if __name__ == "__main__":
    unittest.main()
