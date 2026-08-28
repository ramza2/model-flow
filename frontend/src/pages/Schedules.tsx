import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
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
import { userCanProject, useProject } from "../ProjectContext";

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

export default function Schedules() {
  const { projectId } = useParams();
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
  const [editing, setEditing] = useState<AutomationSchedule | null>(null);
  const [historySchedule, setHistorySchedule] = useState<AutomationSchedule | null>(null);
  const [form, setForm] = useState(defaultForm);

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
      setError(reason instanceof Error ? reason.message : "Schedules could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

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
    setHistorySchedule(schedule);
    try {
      const rows = await api<AutomationScheduleRun[]>(
        `/projects/${projectId}/schedules/${schedule.id}/runs`,
      );
      setRuns(rows);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Run history could not be loaded.");
    }
  }

  function openCreate() {
    setEditing(null);
    setForm(defaultForm());
    setShowForm(true);
  }

  function openEdit(schedule: AutomationSchedule) {
    const config = schedule.target_config;
    setEditing(schedule);
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
    setShowForm(true);
  }

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
      throw new Error("Pipeline parameters must be valid JSON.");
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
        setSuccess("Schedule updated.");
      } else {
        await api(`/projects/${projectId}/schedules`, {
          method: "POST",
          ...jsonBody(payload),
        });
        setSuccess("Schedule created.");
      }
      setShowForm(false);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Schedule could not be saved.");
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
      setError(reason instanceof Error ? reason.message : "Schedule could not be updated.");
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
      setSuccess(`Run now queued for "${schedule.name}".`);
      if (historySchedule?.id === schedule.id) {
        await openHistory(schedule);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Run now failed.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSchedule(schedule: AutomationSchedule) {
    if (!projectId || !canWrite) return;
    if (!window.confirm(`Delete schedule "${schedule.name}"?`)) return;
    setBusy(true);
    setError("");
    try {
      await api(`/projects/${projectId}/schedules/${schedule.id}`, { method: "DELETE" });
      setSuccess("Schedule deleted.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Schedule could not be deleted.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading label="Loading schedules..." />;

  return (
    <div className="page-stack">
      <PageHeader
        title="Schedules"
        description="Automate data imports, batch predictions, and pipeline runs with cron schedules."
        actions={
          canWrite ? (
            <button type="button" className="primary" onClick={openCreate} disabled={busy}>
              Create schedule
            </button>
          ) : undefined
        }
      />
      {error && <ErrorNotice message={error} />}
      {success && <SuccessNotice message={success} />}

      {schedules.length === 0 ? (
        <EmptyState
          title="No schedules yet"
          description="Create a schedule to automate data imports, batch predictions, or pipeline runs."
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Schedule</th>
                <th>Timezone</th>
                <th>Enabled</th>
                <th>Last Run</th>
                <th>Next Run</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((schedule) => (
                <tr key={schedule.id}>
                  <td>{schedule.name}</td>
                  <td>{schedule.target_type.replace("_", " ")}</td>
                  <td><code>{schedule.cron_expression}</code></td>
                  <td>{schedule.timezone}</td>
                  <td>{schedule.is_enabled ? "Yes" : "No"}</td>
                  <td>{schedule.last_run_at ? formatDate(schedule.last_run_at) : "—"}</td>
                  <td>{schedule.next_run_at ? formatDate(schedule.next_run_at) : "—"}</td>
                  <td className="table-actions">
                    {canWrite && (
                      <>
                        <button type="button" onClick={() => void runNow(schedule)} disabled={busy}>
                          Run now
                        </button>
                        <button type="button" onClick={() => void toggleEnabled(schedule)} disabled={busy}>
                          {schedule.is_enabled ? "Disable" : "Enable"}
                        </button>
                        <button type="button" onClick={() => openEdit(schedule)} disabled={busy}>
                          Edit
                        </button>
                        <button type="button" onClick={() => void deleteSchedule(schedule)} disabled={busy}>
                          Delete
                        </button>
                      </>
                    )}
                    <button type="button" onClick={() => void openHistory(schedule)}>
                      History
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {historySchedule && (
        <section className="panel">
          <div className="panel-header">
            <h2>Run history — {historySchedule.name}</h2>
            <button type="button" onClick={() => setHistorySchedule(null)}>Close</button>
          </div>
          {runs.length === 0 ? (
            <p>No runs recorded yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Scheduled</th>
                    <th>Attempt</th>
                    <th>Trigger</th>
                    <th>Status</th>
                    <th>Resource</th>
                    <th>Started</th>
                    <th>Finished</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => {
                    const href = projectId ? resourceLink(projectId, run) : null;
                    return (
                      <tr key={run.id}>
                        <td>{formatDate(run.scheduled_for)}</td>
                        <td>{run.attempt}</td>
                        <td>{run.trigger_source}</td>
                        <td><StatusBadge status={run.status} /></td>
                        <td>
                          {run.target_resource_id && href ? (
                            <Link to={href}>#{run.target_resource_id}</Link>
                          ) : (
                            run.target_resource_id ?? "—"
                          )}
                        </td>
                        <td>{run.started_at ? formatDate(run.started_at) : "—"}</td>
                        <td>{run.finished_at ? formatDate(run.finished_at) : "—"}</td>
                        <td>{run.error_message ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {showForm && (
        <section className="panel">
          <h2>{editing ? "Edit schedule" : "Create schedule"}</h2>
          <form className="form-grid" onSubmit={(event) => void submitForm(event)}>
            <label>
              Name
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </label>
            <label>
              Description
              <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </label>
            <label>
              Type
              <select
                value={form.target_type}
                disabled={Boolean(editing)}
                onChange={(e) => setForm({ ...form, target_type: e.target.value as TargetType })}
              >
                <option value="data_import">Data import</option>
                <option value="batch_inference">Batch prediction</option>
                <option value="pipeline_run">Pipeline run</option>
              </select>
            </label>
            <label>
              Cron preset
              <select
                value={form.cron_preset}
                onChange={(e) => setForm({ ...form, cron_preset: e.target.value })}
              >
                <option value="hourly">Every hour</option>
                <option value="daily">Daily</option>
                <option value="weekdays">Weekdays</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            {form.cron_preset === "custom" && (
              <label>
                Cron expression
                <input
                  value={form.cron_expression}
                  onChange={(e) => setForm({ ...form, cron_expression: e.target.value })}
                  placeholder="0 9 * * *"
                  required
                />
              </label>
            )}
            <label>
              Timezone
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
              Concurrency policy
              <select
                value={form.concurrency_policy}
                onChange={(e) =>
                  setForm({
                    ...form,
                    concurrency_policy: e.target.value as "skip" | "queue",
                  })
                }
              >
                <option value="skip">Skip when busy</option>
                <option value="queue">Queue when busy</option>
              </select>
            </label>
            <label>
              Max concurrent runs
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
              Max retries
              <input
                type="number"
                min={0}
                max={10}
                value={form.max_retries}
                onChange={(e) => setForm({ ...form, max_retries: Number(e.target.value) })}
              />
            </label>
            <label>
              Retry delay (seconds)
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
              Enabled
            </label>

            {form.target_type === "data_import" && (
              <>
                <label>
                  Data source
                  <select
                    value={form.data_source_id}
                    onChange={(e) => setForm({ ...form, data_source_id: e.target.value })}
                    required
                  >
                    <option value="">Select...</option>
                    {dataSources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.name}{source.is_active ? "" : " (inactive)"}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Target dataset name
                  <input
                    value={form.dataset_name}
                    onChange={(e) => setForm({ ...form, dataset_name: e.target.value })}
                    placeholder="Leave blank when using existing dataset ID"
                  />
                </label>
                <label>
                  Existing dataset ID
                  <input
                    value={form.dataset_id}
                    onChange={(e) => setForm({ ...form, dataset_id: e.target.value })}
                  />
                </label>
                <label>
                  Table or query
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
                  Dataset
                  <select
                    value={form.dataset_id}
                    onChange={(e) => setForm({ ...form, dataset_id: e.target.value })}
                    required
                  >
                    <option value="">Select...</option>
                    {datasets.map((dataset) => (
                      <option key={dataset.id} value={dataset.id}>{dataset.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Version strategy
                  <select
                    value={form.dataset_version_strategy}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        dataset_version_strategy: e.target.value as "latest" | "fixed",
                      })
                    }
                  >
                    <option value="latest">Latest</option>
                    <option value="fixed">Fixed</option>
                  </select>
                </label>
                {form.dataset_version_strategy === "fixed" && (
                  <label>
                    Dataset version
                    <select
                      value={form.dataset_version_id}
                      onChange={(e) => setForm({ ...form, dataset_version_id: e.target.value })}
                      required
                    >
                      <option value="">Select...</option>
                      {versions.map((version) => (
                        <option key={version.id} value={version.id}>
                          v{version.version}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  Prediction target
                  <select
                    value={form.batch_target_type}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        batch_target_type: e.target.value as "endpoint" | "model",
                      })
                    }
                  >
                    <option value="endpoint">Endpoint</option>
                    <option value="model">Model version</option>
                  </select>
                </label>
                {form.batch_target_type === "endpoint" ? (
                  <label>
                    Endpoint
                    <select
                      value={form.endpoint_id}
                      onChange={(e) => setForm({ ...form, endpoint_id: e.target.value })}
                      required
                    >
                      <option value="">Select...</option>
                      {endpoints.map((endpoint) => (
                        <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label>
                    Model version
                    <select
                      value={form.model_version_id}
                      onChange={(e) => setForm({ ...form, model_version_id: e.target.value })}
                      required
                    >
                      <option value="">Select...</option>
                      {models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name} v{model.version}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  Result format
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
                  Published pipeline
                  <select
                    value={form.pipeline_id}
                    onChange={(e) => setForm({ ...form, pipeline_id: e.target.value })}
                    required
                  >
                    <option value="">Select...</option>
                    {publishedPipelines.map((pipeline) => (
                      <option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Fail policy
                  <select
                    value={form.fail_policy}
                    onChange={(e) =>
                      setForm({ ...form, fail_policy: e.target.value as "stop" | "continue" })
                    }
                  >
                    <option value="stop">Stop on failure</option>
                    <option value="continue">Continue on failure</option>
                  </select>
                </label>
                <label>
                  Parameters (JSON)
                  <textarea
                    rows={4}
                    value={form.parameters_json}
                    onChange={(e) => setForm({ ...form, parameters_json: e.target.value })}
                  />
                </label>
                {editing && (
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={form.refresh_pinned_version}
                      onChange={(e) =>
                        setForm({ ...form, refresh_pinned_version: e.target.checked })
                      }
                    />
                    Refresh pinned pipeline version to current published version
                  </label>
                )}
              </>
            )}

            <div className="form-actions">
              <button type="button" onClick={() => setShowForm(false)} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={busy}>
                {editing ? "Save changes" : "Create schedule"}
              </button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
