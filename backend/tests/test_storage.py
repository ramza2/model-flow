from app.services import storage


def test_ensure_buckets_can_be_disabled_for_external_object_store(monkeypatch):
    monkeypatch.setattr(storage.settings, "ensure_object_store_buckets", False)

    def fail_client():
        raise AssertionError("s3_client must not be created when bucket bootstrap is disabled")

    monkeypatch.setattr(storage, "s3_client", fail_client)

    storage.ensure_buckets()
