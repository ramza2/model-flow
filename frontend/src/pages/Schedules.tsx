import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  api,
  jsonBody,
  type AutomationSchedule,
  type AutomationScheduleRun,
  type DataSource,
  type Dataset,
  type DatasetVersion,
  type Endpoint,
  type ModelVersion,
  type Pipeline,
} from "../api";
import { useAuth } from "../AuthContext";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
  SuccessNotice,
  formatDate,
} from "../components";
import { Drawer } from "../Drawer";
import {
  cronPresetLabel,
  targetTypeLabel,
} from "../operationsHelpers";
import { userCanProject, useProject } from "../ProjectContext";
import { jobStatusLabel, operationalStatusLabel } from "../uiTerminology";
import {
  hasActiveScheduleRuns,
  SCHEDULE_HISTORY_POLL_INTERVAL_MS,
} from "../scheduleHistoryPolling";

const CRON_PRESETS: Record<string, string> = {
  hourly: "0 * * * *",
  daily: "0 9 * * *",
  weekdays: "0 9 * * 1-5",
  custom: "",
};

const TIMEZONES = ["UTC", "Asia/Seoul", "America/New_York", "Europe/London"];

type TargetType = AutomationSchedule["target_type"];

const defaultForm = () => ({
  name: "",
  description: "",
  target_type: "pipeline_run" as TargetType,
  cron_expression: "0 9 * * *",
  cron_preset: "daily",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  is_enabled: true,
  concurrency_policy: "skip" as "skip" | "queue",
  max_concurrent_runs: 1,
  max_retries: 0,
  retry_delay_seconds: 60,
  data_source_id: "",
  dataset_name: "",
  query_or_table: "",
  dataset_id: "",
  dataset_version_strategy: "latest" as "latest" | "fixed",
  dataset_version_id: "",
  endpoint_id: "",
  model_version_id: "",
  batch_target_type: "endpoint" as "endpoint" | "model",
  result_format: "csv",
  pipeline_id: "",
  fail_policy: "stop" as "stop" | "continue",
  parameters_json: "{}",
  refresh_pinned_version: false,
});

function resourceLink(
  projectId: string,
  run: AutomationScheduleRun,
): string | null {
  if (!run.target_resource_id) return null;
  if (run.target_type === "pipeline_run") {
    return `/projects/${projectId}/pipeline-runs/${run.target_resource_id}`;
  }
  if (run.target_type === "batch_inference") {
    return `/projects/${projectId}/deployments/batch`;
  }
  if (run.target_type === "data_import") {
    return `/projects/${projectId}/data-sources`;
  }
  return null;
}

function scheduleTargetSummary(
  schedule: AutomationSchedule,
  pipelines: Pipeline[],
  datasets: Dataset[],
  endpoints: Endpoint[],
  dataSources: DataSource[],
): string {
  const config = schedule.target_config;
  if (schedule.target_type === "pipeline_run") {
    const pipeline = pipelines.find((row) => row.id === Number(config.pipeline_id));
    return pipeline ? pipeline.name : config.pipeline_id ? `파이프라인 #${config.pipeline_id}` : "—";
  }
  if (schedule.target_type === "batch_inference") {
    const dataset = datasets.find((row) => row.id === Number(config.dataset_id));
    const endpoint = endpoints.find((row) => row.id === Number(config.endpoint_id));
    if (dataset && endpoint) return `${dataset.name} → ${endpoint.name}`;
    if (dataset) return dataset.name;
    return config.dataset_id ? `데이터셋 #${config.dataset_id}` : "—";
  }
  if (schedule.target_type === "data_import") {
    const source = dataSources.find((row) => row.id === Number(config.data_source_id));
    return source ? source.name : config.data_source_id ? `데이터 소스 #${config.data_source_id}` : "—";
  }
  return "—";
}

export default function Schedules() {
  const { projectId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const canWrite = userCanProject(user, selectedProject, "ML_ENGINEER", "PROJECT_ADMIN");

  const [schedules, setSchedules] = useState<AutomationSchedule[]>([]);
  const [runs, setRuns] = useState<AutomationScheduleRun[]>([]);
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [models, setModels] = useState<ModelVersion[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [editing, setEditing] = useState<AutomationSchedule | null>(null);
  const [historySchedule, setHistorySchedule] = useState<AutomationSchedule | null>(null);
  const [form, setForm] = useState(defaultForm);
  const [contextualNotice, setContextualNotice] = useState("");
  const contextualAppliedRef = useRef(false);
  const pollTimeoutRef = useRef<number | null>(null);
  const pollInFlightGenerationRef = useRef<number | null>(null);
  const shouldPollHistoryRef = useRef(false);
  const pollHistoryRef = useRef<(() => Promise<void>) | null>(null);
  const historyRequestGenerationRef = useRef(0);
  const activeHistoryScheduleIdRef = useRef<number | null>(null);

  const isHistoryResponseCurrent = useCallback(
    (generation: number, scheduleId: number) =>
      historyRequestGenerationRef.current === generation
      && activeHistoryScheduleIdRef.current === scheduleId,
    [],
  );

  const beginHistorySession = useCallback((scheduleId: number) => {
    historyRequestGenerationRef.current += 1;
    pollInFlightGenerationRef.current = null;
    activeHistoryScheduleIdRef.current = scheduleId;
    return historyRequestGenerationRef.current;
  }, []);

  const endHistorySession = useCallback(() => {
    historyRequestGenerationRef.current += 1;
    pollInFlightGenerationRef.current = null;
    activeHistoryScheduleIdRef.current = null;
  }, []);

  const stopHistoryPolling = useCallback(() => {
    if (pollTimeoutRef.current !== null) {
      window.clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
  }, []);

  const scheduleHistoryPoll = useCallback((delayMs = SCHEDULE_HISTORY_POLL_INTERVAL_MS) => {
    if (!projectId || activeHistoryScheduleIdRef.current === null || !shouldPollHistoryRef.current) {
      return;
    }
    if (pollTimeoutRef.current !== null) {
      return;
    }
    pollTimeoutRef.current = window.setTimeout(() => {
      pollTimeoutRef.current = null;
      void pollHistoryRef.current?.();
    }, delayMs);
  }, [projectId]);

  const fetchHistoryRuns = useCallback(async (scheduleId: number) => {
    if (!projectId) return [];
    return api<AutomationScheduleRun[]>(
      `/projects/${projectId}/schedules/${scheduleId}/runs`,
    );
  }, [projectId]);

  const pollHistoryRuns = useCallback(async () => {
    const scheduleId = activeHistoryScheduleIdRef.current;
    if (scheduleId === null || !shouldPollHistoryRef.current) {
      return;
    }
    const generation = historyRequestGenerationRef.current;
    if (pollInFlightGenerationRef.current === generation) {
      return;
    }
    pollInFlightGenerationRef.current = generation;
    try {
      const rows = await fetchHistoryRuns(scheduleId);
      if (!isHistoryResponseCurrent(generation, scheduleId)) {
        return;
      }
      setRuns(rows);
      if (!hasActiveScheduleRuns(rows)) {
        stopHistoryPolling();
        return;
      }
      scheduleHistoryPoll();
    } catch {
      if (isHistoryResponseCurrent(generation, scheduleId)) {
        scheduleHistoryPoll();
      }
    } finally {
      if (pollInFlightGenerationRef.current === generation) {
        pollInFlightGenerationRef.current = null;
      }
    }
  }, [
    fetchHistoryRuns,
    isHistoryResponseCurrent,
    scheduleHistoryPoll,
    stopHistoryPolling,
  ]);

  useEffect(() => {
    pollHistoryRef.current = pollHistoryRuns;
  }, [pollHistoryRuns]);

  const publishedPipelines = useMemo(
    () => pipelines.filter((pipeline) => pipeline.status === "published"),
    [pipelines],
  );

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError("");
    try {
      const [
        scheduleRows,
        sourceRows,
        datasetRows,
        endpointRows,
        modelRows,
        pipelineRows,
      ] = await Promise.all([
        api<AutomationSchedule[]>(`/projects/${projectId}/schedules`),
        api<DataSource[]>(`/projects/${projectId}/data-sources`),
        api<Dataset[]>(`/projects/${projectId}/datasets`),
        api<Endpoint[]>(`/projects/${projectId}/endpoints`),
        api<ModelVersion[]>(`/projects/${projectId}/models`),
        api<Pipeline[]>(`/projects/${projectId}/pipelines`),
      ]);
      setSchedules(scheduleRows);
      setDataSources(sourceRows);
      setDatasets(datasetRows);
      setEndpoints(endpointRows);
      setModels(modelRows);
      setPipelines(pipelineRows);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "스케줄 목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => stopHistoryPolling(), [stopHistoryPolling]);

  const shouldPollHistory = Boolean(historySchedule) && hasActiveScheduleRuns(runs);

  useEffect(() => {
    shouldPollHistoryRef.current = shouldPollHistory;
  }, [shouldPollHistory]);

  useEffect(() => {
    if (!historySchedule || !shouldPollHistory) {
      stopHistoryPolling();
      return;
    }
    scheduleHistoryPoll();
    return stopHistoryPolling;
  }, [historySchedule, scheduleHistoryPoll, shouldPollHistory, stopHistoryPolling]);

  useEffect(() => {
    if (!projectId || !form.dataset_id) {
      setVersions([]);
      return;
    }
    api<DatasetVersion[]>(`/projects/${projectId}/datasets/${form.dataset_id}/versions`)
      .then(setVersions)
      .catch(() => setVersions([]));
  }, [form.dataset_id, projectId]);

  async function openHistory(schedule: AutomationSchedule) {
    if (!projectId) return;
    stopHistoryPolling();
    const generation = beginHistorySession(schedule.id);
    setHistorySchedule(schedule);
    try {
      const rows = await fetchHistoryRuns(schedule.id);
      if (!isHistoryResponseCurrent(generation, schedule.id)) {
        return;
      }
      setRuns(rows);
    } catch (reason) {
      if (!isHistoryResponseCurrent(generation, schedule.id)) {
        return;
      }
      setError(reason instanceof Error ? reason.message : "실행 이력을 불러오지 못했습니다.");
    }
  }

  function closeHistory() {
    stopHistoryPolling();
    endHistorySession();
    setHistorySchedule(null);
  }

  const closeForm = useCallback(() => {
    setShowForm(false);
    setShowAdvanced(false);
    setEditing(null);
    setContextualNotice("");
    if (searchParams.has("create") || searchParams.has("pipeline_id") || searchParams.has("target_type")) {
      const next = new URLSearchParams(searchParams);
      next.delete("create");
      next.delete("pipeline_id");
      next.delete("target_type");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  function openCreate(prefill?: Partial<ReturnType<typeof defaultForm>>, notice = "") {
    setEditing(null);
    const next = { ...defaultForm(), ...prefill };
    setForm(next);
    setShowAdvanced(next.cron_preset === "custom" || Boolean(prefill?.parameters_json && prefill.parameters_json !== "{}"));
    setContextualNotice(notice);
    setShowForm(true);
  }

  function openEdit(schedule: AutomationSchedule) {
    const config = schedule.target_config;
    setEditing(schedule);
    setContextualNotice("");
    setForm({
      ...defaultForm(),
      name: schedule.name,
      description: schedule.description,
      target_type: schedule.target_type,
      cron_expression: schedule.cron_expression,
      cron_preset: "custom",
      timezone: schedule.timezone,
      is_enabled: schedule.is_enabled,
      concurrency_policy: schedule.concurrency_policy,
      max_concurrent_runs: schedule.max_concurrent_runs,
      max_retries: schedule.max_retries,
      retry_delay_seconds: schedule.retry_delay_seconds,
      data_source_id: String(config.data_source_id ?? ""),
      dataset_name: "",
      query_or_table: String(config.query_or_table ?? ""),
      dataset_id: String(config.dataset_id ?? ""),
      dataset_version_strategy:
        (config.dataset_version_strategy as "latest" | "fixed") || "latest",
      dataset_version_id: String(config.dataset_version_id ?? ""),
      endpoint_id: String(config.endpoint_id ?? ""),
      model_version_id: String(config.model_version_id ?? ""),
      batch_target_type: config.endpoint_id ? "endpoint" : "model",
      result_format: String(config.result_format ?? "csv"),
      pipeline_id: String(config.pipeline_id ?? ""),
      fail_policy: (config.fail_policy as "stop" | "continue") || "stop",
      parameters_json: JSON.stringify(config.parameters ?? {}, null, 2),
      refresh_pinned_version: false,
    });
    setShowAdvanced(true);
    setShowForm(true);
  }

  useEffect(() => {
    if (loading || !canWrite || contextualAppliedRef.current) return;
    const wantsCreate = searchParams.get("create") === "1";
    if (!wantsCreate) return;
    contextualAppliedRef.current = true;
    const targetType = searchParams.get("target_type");
    const pipelineId = searchParams.get("pipeline_id");
    const prefill: Partial<ReturnType<typeof defaultForm>> = {};
    let notice = "";
    if (targetType === "pipeline_run" || targetType === "batch_inference" || targetType === "data_import") {
      prefill.target_type = targetType;
    }
    if (pipelineId) {
      prefill.target_type = "pipeline_run";
      const published = publishedPipelines.some((pipeline) => String(pipeline.id) === pipelineId);
      if (published) {
        prefill.pipeline_id = pipelineId;
      } else {
        prefill.pipeline_id = "";
        notice = "스케줄에 등록하려면 파이프라인을 먼저 게시해야 합니다.";
      }
    }
    openCreate(prefill, notice);
  }, [canWrite, loading, publishedPipelines, searchParams]);

  function buildTargetConfig() {
    if (form.target_type === "data_import") {
      return {
        data_source_id: Number(form.data_source_id),
        dataset_name: form.dataset_name || undefined,
        dataset_id: form.dataset_id ? Number(form.dataset_id) : undefined,
        query_or_table: form.query_or_table,
      };
    }
    if (form.target_type === "batch_inference") {
      return {
        dataset_id: Number(form.dataset_id),
        dataset_version_strategy: form.dataset_version_strategy,
        dataset_version_id:
          form.dataset_version_strategy === "fixed"
            ? Number(form.dataset_version_id)
            : undefined,
        endpoint_id:
          form.batch_target_type === "endpoint" ? Number(form.endpoint_id) : undefined,
        model_version_id:
          form.batch_target_type === "model" ? Number(form.model_version_id) : undefined,
        result_format: form.result_format,
      };
    }
    let parameters: Record<string, unknown> = {};
    try {
      parameters = JSON.parse(form.parameters_json || "{}") as Record<string, unknown>;
    } catch {
      throw new Error("파이프라인 매개변수는 유효한 JSON 형식이어야 합니다.");
    }
    if (!publishedPipelines.some((pipeline) => String(pipeline.id) === String(form.pipeline_id))) {
      throw new Error("스케줄에 등록하려면 파이프라인을 먼저 게시해야 합니다.");
    }
    return {
      pipeline_id: Number(form.pipeline_id),
      parameters,
      fail_policy: form.fail_policy,
    };
  }

  async function submitForm(event: FormEvent) {
    event.preventDefault();
    if (!projectId || !canWrite) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const payload = {
        name: form.name,
        description: form.description,
        target_type: form.target_type,
        target_config: buildTargetConfig(),
        cron_expression:
          form.cron_preset === "custom" ? form.cron_expression : CRON_PRESETS[form.cron_preset],
        timezone: form.timezone,
        is_enabled: form.is_enabled,
        concurrency_policy: form.concurrency_policy,
        max_concurrent_runs: form.max_concurrent_runs,
        max_retries: form.max_retries,
        retry_delay_seconds: form.retry_delay_seconds,
      };
      if (editing) {
        await api(`/projects/${projectId}/schedules/${editing.id}`, {
          method: "PATCH",
          ...jsonBody({
            ...payload,
            refresh_pinned_version: form.refresh_pinned_version,
          }),
        });
        setSuccess("스케줄을 수정했습니다.");
      } else {
        await api(`/projects/${projectId}/schedules`, {
          method: "POST",
          ...jsonBody(payload),
        });
        setSuccess("스케줄을 생성했습니다.");
      }
      closeForm();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "스케줄을 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(schedule: AutomationSchedule) {
    if (!projectId || !canWrite) return;
    setBusy(true);
    setError("");
    try {
      const path = schedule.is_enabled ? "disable" : "enable";
      await api(`/projects/${projectId}/schedules/${schedule.id}/${path}`, { method: "POST" });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "스케줄 상태를 변경하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function runNow(schedule: AutomationSchedule) {
    if (!projectId || !canWrite) return;
    setBusy(true);
    setError("");
    try {
      await api(`/projects/${projectId}/schedules/${schedule.id}/run-now`, { method: "POST" });
      setSuccess(`“${schedule.name}” 즉시 실행을 요청했습니다.`);
      await load();
      if (historySchedule?.id === schedule.id) {
        await openHistory(schedule);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "즉시 실행에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSchedule(schedule: AutomationSchedule) {
    if (!projectId || !canWrite) return;
    if (!window.confirm(`“${schedule.name}” 스케줄을 삭제하시겠습니까?`)) return;
    setBusy(true);
    setError("");
    try {
      await api(`/projects/${projectId}/schedules/${schedule.id}`, { method: "DELETE" });
      setSuccess("스케줄을 삭제했습니다.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "스케줄을 삭제하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading label="스케줄 불러오는 중…" />;

  return (
    <div className="page-stack ops-page">
      <PageHeader
        title="스케줄"
        description="데이터 가져오기·일괄 예측·파이프라인 실행을 자동화할 일정을 관리합니다."
        actions={
          canWrite ? (
            <button type="button" className="btn" data-testid="schedule-create-open" onClick={() => openCreate()} disabled={busy}>
              스케줄 만들기
            </button>
          ) : undefined
        }
      />
      {error && <ErrorNotice message={error} />}
      {success && <SuccessNotice message={success} />}

      {schedules.length === 0 ? (
        <EmptyState
          title="등록된 스케줄이 없습니다"
          description="스케줄을 만들면 데이터 가져오기·일괄 예측·파이프라인 실행을 자동으로 처리할 수 있습니다."
          action={
            canWrite ? (
              <button type="button" className="btn" data-testid="schedule-empty-create" onClick={() => openCreate()}>
                스케줄 만들기
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="panel table-wrap catalog-table schedules-catalog-table">
          <table data-testid="schedules-catalog">
            <thead>
              <tr>
                <th>이름</th>
                <th>실행 대상</th>
                <th>실행 주기</th>
                <th>시간대</th>
                <th>사용 상태</th>
                <th>최근 실행</th>
                <th>다음 실행</th>
                <th>작업</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((schedule) => (
                <tr key={schedule.id} className={schedule.is_enabled ? undefined : "is-inactive"}>
                  <td>
                    <strong className="catalog-primary-text">{schedule.name}</strong>
                    {schedule.description ? (
                      <small className="table-subtitle">{schedule.description}</small>
                    ) : null}
                  </td>
                  <td>
                    <span className="type-chip">{targetTypeLabel(schedule.target_type)}</span>
                    <small className="table-subtitle break-word">
                      {scheduleTargetSummary(schedule, pipelines, datasets, endpoints, dataSources)}
                    </small>
                  </td>
                  <td>
                    <div>{cronPresetLabel(schedule.cron_expression)}</div>
                    <small className="table-subtitle mono break-word">{schedule.cron_expression}</small>
                  </td>
                  <td className="catalog-meta-date">{schedule.timezone}</td>
                  <td>
                    <StatusBadge status={schedule.is_enabled ? "enabled" : "disabled"} label={operationalStatusLabel(schedule.is_enabled ? "enabled" : "disabled")} />
                  </td>
                  <td className="catalog-meta-date">
                    {schedule.last_run_at ? formatDate(schedule.last_run_at) : "—"}
                  </td>
                  <td className="catalog-meta-date">
                    {schedule.next_run_at ? formatDate(schedule.next_run_at) : "—"}
                  </td>
                  <td>
                    <div className="schedule-actions">
                      <div className="row-actions schedule-actions-primary">
                        {canWrite && (
                          <button type="button" className="btn" onClick={() => void runNow(schedule)} disabled={busy}>
                            지금 실행
                          </button>
                        )}
                        <button type="button" className="btn secondary" onClick={() => void openHistory(schedule)}>
                          실행 이력
                        </button>
                        {canWrite && (
                          <button type="button" className="btn secondary" onClick={() => openEdit(schedule)} disabled={busy}>
                            수정
                          </button>
                        )}
                      </div>
                      {canWrite && (
                        <div className="row-actions schedule-actions-secondary">
                          <button type="button" className="btn link" onClick={() => void toggleEnabled(schedule)} disabled={busy}>
                            {schedule.is_enabled ? "비활성화" : "활성화"}
                          </button>
                          <button type="button" className="btn link danger-text" onClick={() => void deleteSchedule(schedule)} disabled={busy}>
                            삭제
                          </button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {historySchedule && (
        <section className="panel schedule-history-section">
          <div className="panel-header row-actions">
            <div>
              <span className="eyebrow">실행 이력</span>
              <h2>실행 이력 — {historySchedule.name}</h2>
            </div>
            <button type="button" className="btn secondary" onClick={closeHistory}>닫기</button>
          </div>
          {runs.length === 0 ? (
            <p className="muted">기록된 실행 이력이 없습니다.</p>
          ) : (
            <div className="table-wrap catalog-table">
              <table>
                <thead>
                  <tr>
                    <th>예정 시각</th>
                    <th>시도 횟수</th>
                    <th>실행 계기</th>
                    <th>상태</th>
                    <th>대상 리소스</th>
                    <th>시작 시각</th>
                    <th>종료 시각</th>
                    <th>오류 내용</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => {
                    const href = projectId ? resourceLink(projectId, run) : null;
                    return (
                      <tr key={run.id}>
                        <td className="catalog-meta-date">{formatDate(run.scheduled_for)}</td>
                        <td className="tabular-num">{run.attempt}</td>
                        <td>{run.trigger_source === "manual" ? "수동" : run.trigger_source === "scheduled" ? "예약" : run.trigger_source === "retry" ? "재시도" : run.trigger_source}</td>
                        <td><StatusBadge status={run.status} label={jobStatusLabel(run.status)} /></td>
                        <td className="mono">
                          {run.target_resource_id && href ? (
                            <Link to={href}>#{run.target_resource_id}</Link>
                          ) : (
                            run.target_resource_id ?? "—"
                          )}
                        </td>
                        <td className="catalog-meta-date">{run.started_at ? formatDate(run.started_at) : "—"}</td>
                        <td className="catalog-meta-date">{run.finished_at ? formatDate(run.finished_at) : "—"}</td>
                        <td className={`break-word${run.error_message ? " danger-text" : ""}`}>
                          {run.error_message ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <Drawer
        open={showForm}
        title={editing ? "스케줄 수정" : "스케줄 만들기"}
        onClose={closeForm}
        testId="schedule-drawer"
        footer={(
          <div className="form-actions row-actions">
            <button type="button" className="btn secondary" onClick={closeForm} disabled={busy}>
              취소
            </button>
            <button type="submit" form="schedule-form" className="btn" data-testid="schedule-submit" disabled={busy}>
              {editing ? "변경 사항 저장" : "스케줄 만들기"}
            </button>
          </div>
        )}
      >
        <form id="schedule-form" className="form-grid" onSubmit={(event) => void submitForm(event)}>
          {contextualNotice ? (
            <ErrorNotice message={contextualNotice} />
          ) : null}
          <label>
            이름
            <input
              data-drawer-initial-focus
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </label>
          <label>
            설명
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <label>
            실행 대상 유형
            <select
              value={form.target_type}
              disabled={Boolean(editing)}
              onChange={(e) => setForm({ ...form, target_type: e.target.value as TargetType })}
            >
              <option value="data_import">데이터 가져오기</option>
              <option value="batch_inference">일괄 예측</option>
              <option value="pipeline_run">파이프라인 실행</option>
            </select>
          </label>
          <label>
            실행 주기
            <select
              value={form.cron_preset}
              onChange={(e) => {
                const cron_preset = e.target.value;
                setForm({ ...form, cron_preset });
                if (cron_preset === "custom") setShowAdvanced(true);
              }}
            >
              <option value="hourly">매시간</option>
              <option value="daily">매일</option>
              <option value="weekdays">평일</option>
              <option value="custom">사용자 지정(Cron)</option>
            </select>
          </label>
          <label>
            시간대
            <select
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
            >
              {TIMEZONES.includes(form.timezone) ? null : (
                <option value={form.timezone}>{form.timezone}</option>
              )}
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </label>
          <label>
            동시 실행 정책
            <select
              value={form.concurrency_policy}
              onChange={(e) =>
                setForm({
                  ...form,
                  concurrency_policy: e.target.value as "skip" | "queue",
                })
              }
            >
              <option value="skip">실행 중이면 건너뛰기</option>
              <option value="queue">실행 중이면 대기열에 추가</option>
            </select>
          </label>
          <label>
            최대 동시 실행 수
            <input
              type="number"
              min={1}
              max={10}
              value={form.max_concurrent_runs}
              onChange={(e) =>
                setForm({ ...form, max_concurrent_runs: Number(e.target.value) })
              }
            />
          </label>
          <label>
            최대 재시도 횟수
            <input
              type="number"
              min={0}
              max={10}
              value={form.max_retries}
              onChange={(e) => setForm({ ...form, max_retries: Number(e.target.value) })}
            />
          </label>
          <label>
            재시도 간격 (초)
            <input
              type="number"
              min={1}
              value={form.retry_delay_seconds}
              onChange={(e) =>
                setForm({ ...form, retry_delay_seconds: Number(e.target.value) })
              }
            />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.is_enabled}
              onChange={(e) => setForm({ ...form, is_enabled: e.target.checked })}
            />
            활성화
          </label>

          {form.target_type === "data_import" && (
            <>
              <label>
                데이터 소스
                <select
                  value={form.data_source_id}
                  onChange={(e) => setForm({ ...form, data_source_id: e.target.value })}
                  required
                >
                  <option value="">선택하세요</option>
                  {dataSources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.name}{source.is_active ? "" : " (비활성)"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                가져올 데이터셋 이름
                <input
                  value={form.dataset_name}
                  onChange={(e) => setForm({ ...form, dataset_name: e.target.value })}
                  placeholder="기존 데이터셋 ID 사용 시 비워 두세요"
                />
              </label>
              <label>
                기존 데이터셋 ID
                <input
                  value={form.dataset_id}
                  onChange={(e) => setForm({ ...form, dataset_id: e.target.value })}
                />
              </label>
              <label>
                테이블 또는 쿼리
                <input
                  value={form.query_or_table}
                  onChange={(e) => setForm({ ...form, query_or_table: e.target.value })}
                  required
                />
              </label>
            </>
          )}

          {form.target_type === "batch_inference" && (
            <>
              <label>
                데이터셋
                <select
                  value={form.dataset_id}
                  onChange={(e) => setForm({ ...form, dataset_id: e.target.value })}
                  required
                >
                  <option value="">선택하세요</option>
                  {datasets.map((dataset) => (
                    <option key={dataset.id} value={dataset.id}>{dataset.name}</option>
                  ))}
                </select>
              </label>
              <label>
                버전 선택 방식
                <select
                  value={form.dataset_version_strategy}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      dataset_version_strategy: e.target.value as "latest" | "fixed",
                    })
                  }
                >
                  <option value="latest">최신 버전</option>
                  <option value="fixed">특정 버전</option>
                </select>
              </label>
              {form.dataset_version_strategy === "fixed" && (
                <label>
                  데이터셋 버전
                  <select
                    value={form.dataset_version_id}
                    onChange={(e) => setForm({ ...form, dataset_version_id: e.target.value })}
                    required
                  >
                    <option value="">선택하세요</option>
                    {versions.map((version) => (
                      <option key={version.id} value={version.id}>
                        v{version.version}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                예측 실행 대상
                <select
                  value={form.batch_target_type}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      batch_target_type: e.target.value as "endpoint" | "model",
                    })
                  }
                >
                  <option value="endpoint">배포 엔드포인트</option>
                  <option value="model">모델 버전</option>
                </select>
              </label>
              {form.batch_target_type === "endpoint" ? (
                <label>
                  배포 엔드포인트
                  <select
                    value={form.endpoint_id}
                    onChange={(e) => setForm({ ...form, endpoint_id: e.target.value })}
                    required
                  >
                    <option value="">선택하세요</option>
                    {endpoints.map((endpoint) => (
                      <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <label>
                  모델 버전
                  <select
                    value={form.model_version_id}
                    onChange={(e) => setForm({ ...form, model_version_id: e.target.value })}
                    required
                  >
                    <option value="">선택하세요</option>
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name} v{model.version}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                결과 파일 형식
                <select
                  value={form.result_format}
                  onChange={(e) => setForm({ ...form, result_format: e.target.value })}
                >
                  <option value="csv">CSV</option>
                  <option value="json">JSON</option>
                  <option value="parquet">Parquet</option>
                </select>
              </label>
            </>
          )}

          {form.target_type === "pipeline_run" && (
            <>
              <label>
                파이프라인
                <select
                  value={form.pipeline_id}
                  onChange={(e) => setForm({ ...form, pipeline_id: e.target.value })}
                  required
                  data-testid="schedule-pipeline-select"
                >
                  <option value="">선택하세요</option>
                  {publishedPipelines.map((pipeline) => (
                    <option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>
                  ))}
                </select>
              </label>
              <label>
                실패 시 처리
                <select
                  value={form.fail_policy}
                  onChange={(e) =>
                    setForm({ ...form, fail_policy: e.target.value as "stop" | "continue" })
                  }
                >
                  <option value="stop">실패 시 중단</option>
                  <option value="continue">실패해도 계속</option>
                </select>
              </label>
            </>
          )}

          <div className="ops-advanced">
            <button
              type="button"
              className="btn link"
              data-testid="schedule-advanced-toggle"
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((value) => !value)}
            >
              {showAdvanced ? "고급 설정 닫기" : "고급 설정 보기"}
            </button>
            {showAdvanced && (
              <div className="ops-advanced-body" data-testid="schedule-advanced">
                {form.cron_preset === "custom" && (
                  <label>
                    Cron 표현식
                    <input
                      className="mono"
                      value={form.cron_expression}
                      onChange={(e) => setForm({ ...form, cron_expression: e.target.value })}
                      placeholder="0 9 * * *"
                      required
                    />
                  </label>
                )}
                {form.target_type === "pipeline_run" && (
                  <label>
                    매개변수(JSON)
                    <textarea
                      rows={4}
                      className="mono"
                      value={form.parameters_json}
                      onChange={(e) => setForm({ ...form, parameters_json: e.target.value })}
                    />
                  </label>
                )}
                {editing && form.target_type === "pipeline_run" && (
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={form.refresh_pinned_version}
                      onChange={(e) =>
                        setForm({ ...form, refresh_pinned_version: e.target.checked })
                      }
                    />
                    고정된 파이프라인 버전을 현재 게시 버전으로 갱신
                  </label>
                )}
                {form.cron_preset !== "custom" && form.target_type !== "pipeline_run" && !editing && (
                  <p className="muted">이 설정에는 추가 고급 항목이 없습니다.</p>
                )}
              </div>
            )}
          </div>
        </form>
      </Drawer>
    </div>
  );
}
