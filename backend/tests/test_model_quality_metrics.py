"""Unit tests for Phase 5-A model quality metrics and thresholds."""

from __future__ import annotations

from app.services import model_quality as mq


def test_classification_metrics_and_thresholds():
    metrics = mq.compute_quality_metrics(
        predictions=["a", "a", "b", "b"],
        actuals=["a", "b", "b", "b"],
        problem_type="classification",
        target_columns=["target"],
    )
    assert set(metrics) >= {"accuracy", "precision_macro", "recall_macro", "f1_macro"}
    assert metrics["accuracy"] == 0.75
    primary = mq.extract_primary_metric_value(metrics, "f1_macro")
    assert primary is not None
    assert (
        mq.evaluate_thresholds(
            primary_value=primary,
            primary_metric="f1_macro",
            warning_threshold=0.9,
            critical_threshold=0.95,
            matched_count=4,
            minimum_matched_samples=2,
        )
        == "critical"
    )


def test_regression_and_multi_output_metrics():
    single = mq.compute_quality_metrics(
        predictions=[1.0, 2.0, 3.0],
        actuals=[1.5, 2.5, 2.5],
        problem_type="regression",
        target_columns=["y"],
    )
    assert set(single) == {"mae", "rmse", "r2"}
    multi = mq.compute_quality_metrics(
        predictions=[
            {"target_a": 1.0, "target_b": 2.0},
            {"target_a": 2.0, "target_b": 3.0},
        ],
        actuals=[
            {"target_a": 1.2, "target_b": 2.1},
            {"target_a": 1.8, "target_b": 2.7},
        ],
        problem_type="regression",
        target_columns=["target_a", "target_b"],
    )
    assert "aggregate" in multi and "targets" in multi
    assert set(multi["targets"]["target_a"]) == {"mae", "rmse", "r2"}
    assert (
        mq.evaluate_thresholds(
            primary_value=mq.extract_primary_metric_value(multi, "rmse"),
            primary_metric="rmse",
            warning_threshold=0.05,
            critical_threshold=0.1,
            matched_count=2,
            minimum_matched_samples=2,
        )
        in {"ok", "warning", "critical"}
    )


def test_insufficient_data_status():
    assert (
        mq.evaluate_thresholds(
            primary_value=0.99,
            primary_metric="f1_macro",
            warning_threshold=0.8,
            critical_threshold=0.7,
            matched_count=3,
            minimum_matched_samples=10,
        )
        == "insufficient_data"
    )


def test_normalize_actual_validation():
    assert mq.normalize_actual(1.5, target_columns=["y"], problem_type="regression") == 1.5
    multi = mq.normalize_actual(
        {"target_a": 1, "target_b": 2},
        target_columns=["target_a", "target_b"],
        problem_type="regression",
    )
    assert multi == {"target_a": 1.0, "target_b": 2.0}
    try:
        mq.normalize_actual({"target_a": 1}, target_columns=["target_a", "target_b"], problem_type="regression")
        assert False, "expected ValueError"
    except ValueError:
        pass
