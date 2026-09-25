"""Model selection is explicit, loopback-only, and never silently falls back."""

from chem_workbench import orchestrator


def inventory(*args):
    return {
        "models": [
            {"key": "google/gemma-4-e2b", "loaded_instances": [{"id": "e2b-test"}]},
            {"key": "google/gemma-4-e4b", "loaded_instances": []},
        ]
    }


def test_default_e4b_does_not_silently_use_loaded_e2b(monkeypatch):
    monkeypatch.delenv("CHEM_MODEL_KEY", raising=False)
    monkeypatch.setattr(orchestrator, "local_request", inventory)
    status = orchestrator.model_status()
    assert status["key"] == "google/gemma-4-e4b"
    assert status["installed"] and not status["available"]
    assert status["model_id"] is None


def test_explicit_e2b_selection_is_supported(monkeypatch):
    monkeypatch.setenv("CHEM_MODEL_KEY", "google/gemma-4-e2b")
    monkeypatch.setattr(orchestrator, "local_request", inventory)
    assert orchestrator.model_status()["model_id"] == "e2b-test"


def test_unknown_model_cannot_redirect_provider(monkeypatch):
    monkeypatch.setenv("CHEM_MODEL_KEY", "https://foreign.example/model")

    def forbidden(*args):
        raise AssertionError("Unknown selection must not issue a provider request")

    monkeypatch.setattr(orchestrator, "local_request", forbidden)
    assert not orchestrator.model_status()["available"]
