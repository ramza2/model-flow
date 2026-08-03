from types import SimpleNamespace

from app.services import mlflow_service


def test_artifact_exists_accepts_mlflow3_logged_model(monkeypatch):
    class FakeClient:
        def list_artifacts(self, run_id, parent):
            assert (run_id, parent) == ("run-1", None)
            return []

        def get_run(self, run_id):
            assert run_id == "run-1"
            return SimpleNamespace(info=SimpleNamespace(experiment_id="experiment-1"))

        def search_logged_models(self, *, experiment_ids, max_results):
            assert experiment_ids == ["experiment-1"]
            assert max_results == 1000
            return [
                SimpleNamespace(
                    source_run_id="run-1",
                    name="model",
                    status="READY",
                )
            ]

    monkeypatch.setattr(mlflow_service, "client", FakeClient)

    assert mlflow_service.artifact_exists("run-1", "model") is True
    assert mlflow_service.artifact_exists("run-1", "other") is False
