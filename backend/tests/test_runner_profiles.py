"""Phase 8-B runner profile / capability routing contract tests."""

import pytest

from app.services.runner_profiles import (
    DEFAULT_REQUIRED_PROFILE,
    capabilities_for_profile,
    normalize_worker_profile,
    required_profile_for_workload,
    worker_can_claim,
)


def test_default_workload_requires_general():
    assert required_profile_for_workload() == "general"
    assert required_profile_for_workload("training") == DEFAULT_REQUIRED_PROFILE


def test_general_worker_eligible_for_general():
    assert worker_can_claim("general", "general") is True


def test_gpu_requirement_ineligible_on_general_worker():
    assert worker_can_claim("gpu", "general") is False


def test_general_requirement_ineligible_on_gpu_worker():
    """GPU workers must not steal sklearn/general jobs."""

    assert worker_can_claim("general", "gpu") is False


def test_unknown_requirement_fail_closed():
    assert worker_can_claim("tpu", "general") is False
    assert worker_can_claim("general", "tpu") is False
    assert worker_can_claim("", "general") is False


def test_capabilities_for_known_profiles():
    assert capabilities_for_profile("general") == ("cpu",)
    assert capabilities_for_profile("gpu") == ("cpu", "gpu")


def test_normalize_rejects_unknown_profile():
    with pytest.raises(ValueError):
        normalize_worker_profile("cuda-only")
