from __future__ import annotations

import json
import threading
import time
from collections import Counter

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.models import (
    Base,
    JobStatus,
    Pipeline,
    PipelineRun,
    PipelineVersion,
    Project,
)
from app.services import pipeline_engine


@pytest.fixture
def pipeline_db(tmp_path):
    engine = create_engine(
        f"sqlite+pysqlite:///{tmp_path / 'pipeline.db'}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    local_session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    with local_session() as db:
        yield db
    Base.metadata.drop_all(engine)
    engine.dispose()


def _node(node_id: str, node_type: str = "notification", **config):
    return {
        "id": node_id,
        "data": {
            "node_type": node_type,
            "config": {"test_id": node_id, **config},
        },
    }


def _seed_run(db, graph, *, fail_policy: str = "stop") -> PipelineRun:
    project = Project(name=f"pipeline-project-{time.time_ns()}")
    db.add(project)
    db.flush()
    pipeline = Pipeline(project_id=project.id, name="runtime-test")
    db.add(pipeline)
    db.flush()
    version = PipelineVersion(
        pipeline_id=pipeline.id,
        project_id=project.id,
        version=1,
        graph_json=json.dumps(graph),
    )
    db.add(version)
    db.flush()
    run = PipelineRun(
        project_id=project.id,
        pipeline_id=pipeline.id,
        pipeline_version_id=version.id,
        status=JobStatus.pending,
        fail_policy=fail_policy,
        node_states_json=json.dumps(
            {str(node["id"]): {"status": "pending"} for node in graph["nodes"]}
        ),
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def _states(run: PipelineRun) -> dict:
    return json.loads(run.node_states_json)


def test_independent_ready_nodes_execute_in_parallel(pipeline_db, monkeypatch):
    run = _seed_run(
        pipeline_db,
        {"nodes": [_node("left"), _node("right")], "edges": []},
    )
    active = 0
    peak = 0
    lock = threading.Lock()

    def execute(db, live_run, node_type, config, incoming):
        nonlocal active, peak
        snapshot = json.loads(live_run.node_states_json)
        assert snapshot["left"]["status"] == "running"
        assert snapshot["right"]["status"] == "running"
        with lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.1)
        with lock:
            active -= 1
        return {"node": config["test_id"]}

    monkeypatch.setattr(pipeline_engine, "_execute_node", execute)
    result = pipeline_engine.execute_pipeline_run(pipeline_db, run.id)

    assert result.status == JobStatus.succeeded
    assert {state["status"] for state in _states(result).values()} == {"succeeded"}
    assert peak == 2


@pytest.mark.parametrize(
    ("left", "right", "expected_branch", "selected", "skipped"),
    [
        (1, 1, "true", "true-path", "false-path"),
        (1, 2, "false", "false-path", "true-path"),
    ],
)
def test_condition_follows_only_selected_branch(
    pipeline_db,
    monkeypatch,
    left,
    right,
    expected_branch,
    selected,
    skipped,
):
    graph = {
        "nodes": [
            _node("source"),
            _node("condition", "condition", left=left, right=right, operator="=="),
            _node("true-path"),
            _node("false-path"),
        ],
        "edges": [
            {"source": "source", "target": "condition"},
            {
                "source": "condition",
                "target": "true-path",
                "data": {"branch": "true"},
            },
            {"source": "condition", "target": "false-path", "label": "false"},
        ],
    }
    run = _seed_run(pipeline_db, graph)
    original = pipeline_engine._execute_node
    executed: list[str] = []

    def execute(db, live_run, node_type, config, incoming):
        executed.append(config["test_id"])
        if node_type == "condition":
            return original(db, live_run, node_type, config, incoming)
        return {"node": config["test_id"]}

    monkeypatch.setattr(pipeline_engine, "_execute_node", execute)
    result = pipeline_engine.execute_pipeline_run(pipeline_db, run.id)
    states = _states(result)

    assert result.status == JobStatus.succeeded
    assert states["condition"]["branch"] == expected_branch
    assert states[selected]["status"] == "succeeded"
    assert states[skipped]["status"] == "skipped"
    assert selected in executed
    assert skipped not in executed


def test_rerun_from_failed_reuses_succeeded_output(pipeline_db, monkeypatch):
    graph = {
        "nodes": [_node("first"), _node("flaky"), _node("last")],
        "edges": [
            {"source": "first", "target": "flaky"},
            {"source": "flaky", "target": "last"},
        ],
    }
    run = _seed_run(pipeline_db, graph)
    calls: Counter[str] = Counter()

    def execute(db, live_run, node_type, config, incoming):
        node_id = config["test_id"]
        calls[node_id] += 1
        if node_id == "flaky" and calls[node_id] == 1:
            raise RuntimeError("transient failure")
        if node_id == "flaky":
            assert incoming == {"node": "first"}
        return {"node": node_id}

    monkeypatch.setattr(pipeline_engine, "_execute_node", execute)
    failed = pipeline_engine.execute_pipeline_run(pipeline_db, run.id)
    assert failed.status == JobStatus.failed
    assert _states(failed)["first"]["status"] == "succeeded"

    restarted = pipeline_engine.prepare_rerun_from_failed(failed, graph)
    assert restarted == ["flaky", "last"]
    pipeline_db.commit()
    succeeded = pipeline_engine.execute_pipeline_run(pipeline_db, run.id)

    assert succeeded.status == JobStatus.succeeded
    assert calls == Counter({"flaky": 2, "first": 1, "last": 1})
    assert {state["status"] for state in _states(succeeded).values()} == {"succeeded"}


def test_continue_policy_runs_independent_branch_after_failure(
    pipeline_db, monkeypatch
):
    graph = {
        "nodes": [
            _node("failed"),
            _node("blocked"),
            _node("independent"),
            _node("independent-tail"),
        ],
        "edges": [
            {"source": "failed", "target": "blocked"},
            {"source": "independent", "target": "independent-tail"},
        ],
    }
    run = _seed_run(pipeline_db, graph, fail_policy="continue")

    def execute(db, live_run, node_type, config, incoming):
        if config["test_id"] == "failed":
            raise RuntimeError("expected failure")
        return {"node": config["test_id"]}

    monkeypatch.setattr(pipeline_engine, "_execute_node", execute)
    result = pipeline_engine.execute_pipeline_run(pipeline_db, run.id)
    states = _states(result)

    assert result.status == JobStatus.failed
    assert states["failed"]["status"] == "failed"
    assert states["blocked"]["status"] == "skipped"
    assert states["independent"]["status"] == "succeeded"
    assert states["independent-tail"]["status"] == "succeeded"


def test_cancel_request_stops_scheduling_pending_nodes(pipeline_db, monkeypatch):
    graph = {
        "nodes": [_node("running"), _node("pending")],
        "edges": [{"source": "running", "target": "pending"}],
    }
    run = _seed_run(pipeline_db, graph)
    started = threading.Event()
    release = threading.Event()
    local_session = sessionmaker(
        bind=pipeline_db.get_bind(),
        autocommit=False,
        autoflush=False,
    )

    def execute(db, live_run, node_type, config, incoming):
        if config["test_id"] == "running":
            started.set()
            assert release.wait(timeout=2)
        return {"node": config["test_id"]}

    monkeypatch.setattr(pipeline_engine, "_execute_node", execute)
    error: list[Exception] = []

    def run_pipeline():
        try:
            with local_session() as db:
                pipeline_engine.execute_pipeline_run(db, run.id)
        except Exception as exc:
            error.append(exc)

    thread = threading.Thread(target=run_pipeline)
    thread.start()
    assert started.wait(timeout=2)
    with local_session() as db:
        live = db.get(PipelineRun, run.id)
        live.status = JobStatus.cancel_requested
        db.commit()
    release.set()
    thread.join(timeout=3)
    assert not thread.is_alive()
    assert not error

    pipeline_db.expire_all()
    cancelled = pipeline_db.get(PipelineRun, run.id)
    states = _states(cancelled)
    assert cancelled.status == JobStatus.cancelled
    assert states["running"]["status"] == "succeeded"
    assert states["pending"]["status"] == "cancelled"
