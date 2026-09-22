"""Unit tests for Phase 5-A model quality metrics and thresholds."""

from __future__ import annotations

import math

import pytest

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
    # higher-is-better: critical <= warning (critical=0.7, warning=0.8)
    assert (
        mq.evaluate_thresholds(
            primary_value=0.65,
            primary_metric="f1_macro",
            warning_threshold=0.8,
            critical_threshold=0.7,
            matched_count=4,
            minimum_matched_samples=2,
        )
        == "critical"
    )
    assert (
        mq.evaluate_thresholds(
            primary_value=primary,
            primary_metric="f1_macro",
            warning_threshold=0.8,
            critical_threshold=0.7,
            matched_count=4,
            minimum_matched_samples=2,
        )
        == "warning"
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
    # lower-is-better: critical >= warning
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
    with pytest.raises(ValueError):
        mq.normalize_actual(
            {"target_a": 1},
            target_columns=["target_a", "target_b"],
            problem_type="regression",
        )


def test_validate_policy_f1_valid_and_inverted():
    assert (
        mq.validate_policy_metric_thresholds(
            primary_metric="f1_macro",
            warning_threshold=0.8,
            critical_threshold=0.7,
        )
        == "f1_macro"
    )
    with pytest.raises(ValueError, match="higher-is-better"):
        mq.validate_policy_metric_thresholds(
            primary_metric="f1_macro",
            warning_threshold=0.7,
            critical_threshold=0.8,
        )


def test_validate_policy_rmse_valid_and_inverted():
    assert (
        mq.validate_policy_metric_thresholds(
            primary_metric="rmse",
            warning_threshold=0.1,
            critical_threshold=0.2,
        )
        == "rmse"
    )
    with pytest.raises(ValueError, match="lower-is-better"):
        mq.validate_policy_metric_thresholds(
            primary_metric="rmse",
            warning_threshold=0.2,
            critical_threshold=0.1,
        )


def test_validate_policy_unsupported_and_non_finite():
    with pytest.raises(ValueError, match="Unsupported primary_metric"):
        mq.validate_policy_metric_thresholds(
            primary_metric="auc",
            warning_threshold=0.8,
            critical_threshold=0.7,
        )
    for bad in (math.nan, math.inf, -math.inf):
        with pytest.raises(ValueError, match="finite"):
            mq.validate_policy_metric_thresholds(
                primary_metric="accuracy",
                warning_threshold=0.8,
                critical_threshold=bad,
            )
