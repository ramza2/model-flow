import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiRequestError, type DataImportJob, type DataSource } from "../api";
import { useAuth } from "../AuthContext";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
  SuccessNotice,
  confirmAction,
  formatDate,
} from "../components";
import {
  DEFAULT_POSTGRES_FORM,
  buildPostgresSavePayload,
  extraPostgresConfig,
  postgresFormFromConfig,
  resolvePostgresConnectionMode,
  type PostgresConnectionMode,
} from "../dataSourceForm";
import { userCanProject, useProject } from "../ProjectContext";

type ImportMode = "table" | "sql";

type ImportPanelState = {
  mode: ImportMode;
  schema: string;
  table: string;
  sql: string;
  datasetName: string;
  schemas: string[];
  tables: { schema: string | null; name: string }[];
  schemasLoading: boolean;
  tablesLoading: boolean;
  schemasError: string;
  tablesError: string;
  job: DataImportJob | null;
  submitting: boolean;
};

const emptyImportState = (): ImportPanelState => ({
  mode: "table",
  schema: "",
  table: "",
  sql: "",
  datasetName: "",
  schemas: [],
  tables: [],
  schemasLoading: false,
  tablesLoading: false,
  schemasError: "",
  tablesError: "",
  job: null,
  submitting: false,
});

function suggestDatasetName(tableName: string): string {
  const cleaned = tableName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "imported-dataset";
}

export default function DataSources() {
  const { projectId } = useParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [sources, setSources] = useState<DataSource[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<DataSource | null>(null);
  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<"file" | "postgres">("postgres");
  const [config, setConfig] = useState("{}");
  const [postgresForm, setPostgresForm] = useState(DEFAULT_POSTGRES_FORM);
  const [postgresExtraConfig, setPostgresExtraConfig] = useState<Record<string, unknown>>({});
  const [password, setPassword] = useState("");
  const [connectionMode, setConnectionMode] = useState<PostgresConnectionMode>("host_port");
  const [connectionUrl, setConnectionUrl] = useState("");
  const [previousConnectionMode, setPreviousConnectionMode] =
    useState<PostgresConnectionMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [importingId, setImportingId] = useState<number | null>(null);
  const [importState, setImportState] = useState<ImportPanelState>(emptyImportState);
  const [recentJobs, setRecentJobs] = useState<Record<number, DataImportJob[]>>({});
  const pollRef = useRef<number | null>(null);
  const canWrite = userCanProject(user, selectedProject, "DATA_SCIENTIST", "ML_ENGINEER", "PROJECT_ADMIN");

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const loadRecentJobs = useCallback(
    async (sourceId: number) => {
      try {
        const rows = await api<DataImportJob[]>(
          `/projects/${projectId}/data-import-jobs?data_source_id=${sourceId}&limit=5`,
        );
        setRecentJobs((current) => ({ ...current, [sourceId]: rows }));
      } catch {
        /* non-blocking */
      }
    },
    [projectId],
  );

  const load = useCallback(async () => {
    try {
      setSources(await api<DataSource[]>(`/projects/${projectId}/data-sources`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Data sources could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  function resetForm() {
    setEditing(null);
    setName("");
    setSourceType("postgres");
    setConfig("{}");
    setPostgresForm(DEFAULT_POSTGRES_FORM);
    setPostgresExtraConfig({});
    setPassword("");
    setConnectionMode("host_port");
    setConnectionUrl("");
    setPreviousConnectionMode(null);
    setShowForm(false);
  }

  function editSource(source: DataSource) {
    setEditing(source);
    setName(source.name);
    setSourceType(source.source_type);
    setConfig(JSON.stringify(source.config, null, 2));
    setPostgresForm(postgresFormFromConfig(source.config));
    setPostgresExtraConfig(extraPostgresConfig(source.config));
    setPassword("");
    const mode = resolvePostgresConnectionMode(source.connection_mode);
    setConnectionMode(mode);
    setPreviousConnectionMode(mode);
    setConnectionUrl("");
    setShowForm(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy("save");
    setError("");
    setSuccess("");
    try {
      if (sourceType === "postgres") {
        const payload = buildPostgresSavePayload({
          mode: connectionMode,
          form: postgresForm,
          extra: postgresExtraConfig,
          password,
          connectionUrl,
          editing: Boolean(editing),
          previousMode: previousConnectionMode,
        });
        if (editing) {
          await api(`/projects/${projectId}/data-sources/${editing.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              name,
              config: payload.config,
              secrets: payload.secrets,
              ...(payload.clear_secrets ? { clear_secrets: payload.clear_secrets } : {}),
            }),
          });
          setSuccess("Data source updated.");
        } else {
          await api(`/projects/${projectId}/data-sources`, {
            method: "POST",
            body: JSON.stringify({
              name,
              source_type: sourceType,
              config: payload.config,
              secrets: payload.secrets,
            }),
          });
          setSuccess("Data source created.");
        }
      } else {
        const parsed = JSON.parse(config) as Record<string, unknown>;
        if (editing) {
          await api(`/projects/${projectId}/data-sources/${editing.id}`, {
            method: "PATCH",
            body: JSON.stringify({ name, config: parsed, secrets: {} }),
          });
          setSuccess("Data source updated.");
        } else {
          await api(`/projects/${projectId}/data-sources`, {
            method: "POST",
            body: JSON.stringify({
              name,
              source_type: sourceType,
              config: parsed,
              secrets: {},
            }),
          });
          setSuccess("Data source created.");
        }
      }
      resetForm();
      await load();
    } catch (reason) {
      setError(
        reason instanceof SyntaxError
          ? "Configuration must be valid JSON."
          : reason instanceof Error
            ? reason.message
            : "Data source could not be saved.",
      );
    } finally {
      setBusy("");
    }
  }

  async function testSource(source: DataSource) {
    setBusy(`test-${source.id}`);
    setError("");
    setSuccess("");
    try {
      const result = await api<{ status: string; message: string }>(
        `/projects/${projectId}/data-sources/${source.id}/test`,
        { method: "POST" },
      );
      const message = result.message?.trim() || (
        result.status === "ok" ? "Connection succeeded." : "Connection test failed."
      );
      if (result.status === "ok") {
        setSuccess(message);
      } else {
        setError(message);
      }
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Connection test failed.");
    } finally {
      setBusy("");
    }
  }

  async function activateSource(source: DataSource) {
    setBusy(`activate-${source.id}`);
    setError("");
    try {
      await api(`/projects/${projectId}/data-sources/${source.id}/activate`, { method: "POST" });
      setSuccess(`“${source.name}” activated.`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Data source could not be activated.");
    } finally {
      setBusy("");
    }
  }

  async function deactivateSource(source: DataSource) {
    if (
      !confirmAction(
        `Deactivate “${source.name}”?\n\nNew imports will be disabled.\nPreviously imported datasets and lineage will remain available.`,
      )
    ) {
      return;
    }
    setBusy(`deactivate-${source.id}`);
    setError("");
    try {
      await api(`/projects/${projectId}/data-sources/${source.id}/deactivate`, { method: "POST" });
      setSuccess(`“${source.name}” deactivated.`);
      if (importingId === source.id) {
        stopPolling();
        setImportingId(null);
        setImportState(emptyImportState());
      }
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Data source could not be deactivated.");
    } finally {
      setBusy("");
    }
  }

  async function deleteSource(source: DataSource) {
    if (
      !confirmAction(
        `Delete data source permanently?\n\n“${source.name}” will be permanently removed, including its saved connection credentials.\n\nThis action cannot be undone.`,
      )
    ) {
      return;
    }
    setBusy(`delete-${source.id}`);
    setError("");
    setSuccess("");
    try {
      await api(`/projects/${projectId}/data-sources/${source.id}`, { method: "DELETE" });
      setSuccess(`“${source.name}” permanently deleted.`);
      if (importingId === source.id) {
        stopPolling();
        setImportingId(null);
        setImportState(emptyImportState());
      }
      await load();
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.status === 409) {
        setError(
          reason.hint
            ? `${reason.message.replace(` — ${reason.hint}`, "")} ${reason.hint}`
            : reason.message,
        );
      } else {
        setError(reason instanceof Error ? reason.message : "Data source could not be deleted.");
      }
    } finally {
      setBusy("");
    }
  }

  async function openImport(source: DataSource) {
    stopPolling();
    setError("");
    setSuccess("");
    setImportingId(source.id);
    const next = emptyImportState();
    setImportState(next);
    void loadRecentJobs(source.id);
    setImportState((current) => ({ ...current, schemasLoading: true, schemasError: "" }));
    try {
      const schemas = await api<string[]>(`/projects/${projectId}/data-sources/${source.id}/schemas`);
      setImportState((current) => ({
        ...current,
        schemas,
        schemasLoading: false,
        schema: schemas.includes("public") ? "public" : schemas[0] || "",
      }));
    } catch (reason) {
      setImportState((current) => ({
        ...current,
        schemasLoading: false,
        schemasError:
          reason instanceof Error
            ? reason.message
            : "Could not load schemas. Test the data source connection and try again.",
      }));
    }
  }

  useEffect(() => {
    if (!importingId || !importState.schema || importState.mode !== "table") return;
    let cancelled = false;
    setImportState((current) => ({
      ...current,
      tablesLoading: true,
      tablesError: "",
      table: "",
      tables: [],
    }));
    void (async () => {
      try {
        const tables = await api<{ schema: string | null; name: string }[]>(
          `/projects/${projectId}/data-sources/${importingId}/tables?schema=${encodeURIComponent(importState.schema)}`,
        );
        if (cancelled) return;
        setImportState((current) => ({
          ...current,
          tables,
          tablesLoading: false,
          table: tables[0]?.name || "",
          datasetName: tables[0]?.name ? suggestDatasetName(tables[0].name) : current.datasetName,
        }));
      } catch (reason: unknown) {
        if (cancelled) return;
        setImportState((current) => ({
          ...current,
          tablesLoading: false,
          tablesError:
            reason instanceof Error
              ? reason.message
              : "Could not load tables. Test the data source connection and try again.",
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [importingId, importState.schema, importState.mode, projectId]);

  function startPolling(jobId: number, sourceId: number) {
    stopPolling();
    pollRef.current = window.setInterval(() => {
      void (async () => {
        try {
          const job = await api<DataImportJob>(`/projects/${projectId}/data-import-jobs/${jobId}`);
          setImportState((current) => ({ ...current, job }));
          if (job.status === "succeeded" || job.status === "failed") {
            stopPolling();
            void loadRecentJobs(sourceId);
          }
        } catch (reason) {
          stopPolling();
          setError(reason instanceof Error ? reason.message : "Import status could not be loaded.");
        }
      })();
    }, 2000);
  }

  async function submitImport(source: DataSource) {
    const datasetName = importState.datasetName.trim();
    if (!datasetName) {
      setError("Dataset name is required.");
      return;
    }
    let tableOrQuery = "";
    if (importState.mode === "table") {
      if (!importState.schema || !importState.table) {
        setError("Select a schema and table to import.");
        return;
      }
      tableOrQuery = `${importState.schema}.${importState.table}`;
    } else {
      tableOrQuery = importState.sql.trim();
      if (!tableOrQuery) {
        setError("Enter a read-only SQL query.");
        return;
      }
    }

    setImportState((current) => ({ ...current, submitting: true }));
    setError("");
    setSuccess("");
    try {
      const job = await api<DataImportJob>(`/projects/${projectId}/data-sources/${source.id}/import`, {
        method: "POST",
        body: JSON.stringify({ dataset_name: datasetName, table_or_query: tableOrQuery }),
      });
      setImportState((current) => ({ ...current, job, submitting: false }));
      if (job.status === "pending" || job.status === "running") {
        startPolling(job.id, source.id);
      }
      void loadRecentJobs(source.id);
    } catch (reason) {
      setImportState((current) => ({ ...current, submitting: false }));
      setError(reason instanceof Error ? reason.message : "Import could not be started.");
    }
  }

  function closeImport() {
    stopPolling();
    setImportingId(null);
    setImportState(emptyImportState());
  }

  const importBusy =
    importState.submitting ||
    importState.job?.status === "pending" ||
    importState.job?.status === "running";

  return (
    <div>
      <PageHeader
        title="Data Sources"
        description="Connect managed data systems, import datasets, and control source lifecycle without exposing credentials."
        actions={
          canWrite ? (
            <button className="btn" onClick={() => setShowForm(!showForm)} data-testid="add-data-source">
              ＋ Add data source
            </button>
          ) : undefined
        }
      />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      {canWrite && showForm && (
        <form className="panel form" onSubmit={save} data-testid="data-source-form">
          <div className="panel-title">
            <div>
              <span className="eyebrow">Connection</span>
              <h2>{editing ? "Edit data source" : "New data source"}</h2>
            </div>
          </div>
          <label>
            Name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              placeholder="Analytics warehouse"
              data-testid="data-source-name"
            />
          </label>
          <label>
            Source type
            <select
              value={sourceType}
              disabled={Boolean(editing)}
              onChange={(event) => setSourceType(event.target.value as "file" | "postgres")}
              data-testid="data-source-type"
            >
              <option value="postgres">PostgreSQL</option>
              <option value="file">Managed file source</option>
            </select>
          </label>
          {sourceType === "postgres" ? (
            <>
              <label htmlFor="data-source-connection-mode">
                Connection mode
                <select
                  id="data-source-connection-mode"
                  value={connectionMode}
                  onChange={(event) =>
                    setConnectionMode(event.target.value as PostgresConnectionMode)
                  }
                  data-testid="data-source-connection-mode"
                >
                  <option value="host_port">Host / Port</option>
                  <option value="connection_url">Connection URL / DSN</option>
                </select>
              </label>
              {connectionMode === "connection_url" ? (
                <label htmlFor="data-source-connection-url">
                  Connection URL / DSN
                  <input
                    id="data-source-connection-url"
                    type="password"
                    autoComplete="off"
                    value={connectionUrl}
                    onChange={(event) => setConnectionUrl(event.target.value)}
                    required={!editing || previousConnectionMode === "host_port"}
                    placeholder={
                      editing && previousConnectionMode === "connection_url"
                        ? "Leave blank to keep saved connection URL"
                        : "postgresql://user:password@host:5432/database"
                    }
                    data-testid="data-source-connection-url"
                  />
                  <small>
                    {editing && previousConnectionMode === "connection_url"
                      ? "The saved connection URL is not shown. Leave blank to keep it, or enter a new value to replace it."
                      : "Stored separately from connection metadata. Project members cannot read this value."}
                  </small>
                </label>
              ) : (
                <>
                  <div className="form-grid">
                    <label htmlFor="data-source-host">
                      Host
                      <input
                        id="data-source-host"
                        value={postgresForm.host}
                        onChange={(event) =>
                          setPostgresForm((current) => ({ ...current, host: event.target.value }))
                        }
                        required
                        autoComplete="off"
                        data-testid="data-source-host"
                      />
                    </label>
                    <label htmlFor="data-source-port">
                      Port
                      <input
                        id="data-source-port"
                        type="number"
                        min={1}
                        max={65535}
                        value={postgresForm.port}
                        onChange={(event) =>
                          setPostgresForm((current) => ({ ...current, port: event.target.value }))
                        }
                        required
                        data-testid="data-source-port"
                      />
                    </label>
                    <label htmlFor="data-source-database">
                      Database
                      <input
                        id="data-source-database"
                        value={postgresForm.database}
                        onChange={(event) =>
                          setPostgresForm((current) => ({
                            ...current,
                            database: event.target.value,
                          }))
                        }
                        required
                        autoComplete="off"
                        data-testid="data-source-database"
                      />
                    </label>
                    <label htmlFor="data-source-user">
                      User
                      <input
                        id="data-source-user"
                        value={postgresForm.user}
                        onChange={(event) =>
                          setPostgresForm((current) => ({ ...current, user: event.target.value }))
                        }
                        required
                        autoComplete="off"
                        data-testid="data-source-user"
                      />
                    </label>
                  </div>
                  <label htmlFor="data-source-password">
                    Password
                    <input
                      id="data-source-password"
                      type="password"
                      autoComplete="new-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder={
                        editing?.has_secrets && previousConnectionMode === "host_port"
                          ? "Leave blank to keep saved password"
                          : "Database password"
                      }
                      data-testid="data-source-password"
                    />
                    <small>
                      {editing && previousConnectionMode === "host_port"
                        ? "Leave blank to keep the saved password. Enter a new value only to replace it."
                        : "Stored separately from connection metadata. Project members cannot read this value."}
                    </small>
                  </label>
                </>
              )}
            </>
          ) : (
            <label>
              Configuration
              <textarea
                className="code-input"
                value={config}
                onChange={(event) => setConfig(event.target.value)}
                spellCheck={false}
                data-testid="data-source-config"
              />
              <small>Connection metadata is visible to project members. Do not put passwords in this JSON.</small>
            </label>
          )}
          <div className="row-actions">
            <button className="btn" disabled={busy === "save"} data-testid="data-source-save">
              {busy === "save" ? "Saving…" : "Save data source"}
            </button>
            <button className="btn secondary" type="button" onClick={resetForm}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {loading ? (
        <Loading label="Loading data sources" />
      ) : sources.length === 0 ? (
        <EmptyState
          title="No connected data sources"
          description="Add PostgreSQL or use direct dataset upload to bring data into ModelFlow."
          action={
            canWrite ? (
              <button className="btn" onClick={() => setShowForm(true)}>
                Add data source
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="card-grid">
          {sources.map((source) => (
            <article className="source-card" key={source.id} data-testid={`data-source-card-${source.id}`}>
              <div className="project-card-top">
                <span className="source-icon" aria-hidden="true">
                  {source.source_type === "postgres" ? "▥" : "▤"}
                </span>
                <StatusBadge status={source.is_active ? source.last_test_status || "active" : "inactive"} />
              </div>
              <h2>{source.name}</h2>
              <p className="muted">
                {source.source_type === "postgres" ? "PostgreSQL database" : "Managed file source"}
                {!source.is_active ? " · Inactive" : ""}
              </p>
              <dl className="key-values">
                {Object.entries(source.config)
                  .slice(0, 4)
                  .map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{String(value)}</dd>
                    </div>
                  ))}
                <div>
                  <dt>Last tested</dt>
                  <dd>{formatDate(source.last_tested_at)}</dd>
                </div>
              </dl>
              {source.last_test_message && (
                <p
                  className={`source-message ${source.last_test_status === "ok" ? "ok" : source.last_test_status === "error" ? "err" : ""}`}
                  data-testid={`last-test-message-${source.id}`}
                >
                  {source.last_test_message}
                </p>
              )}
              {(recentJobs[source.id] || []).length > 0 && (
                <div className="source-recent-jobs" data-testid={`recent-imports-${source.id}`}>
                  <span className="eyebrow">Recent imports</span>
                  <ul>
                    {(recentJobs[source.id] || []).slice(0, 3).map((job) => (
                      <li key={job.id}>
                        <StatusBadge status={job.status} /> #{job.id}{" "}
                        <span className="muted">{job.table_or_query.slice(0, 48)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {canWrite && (
                <div className="row-actions">
                  {source.is_active && (
                    <button
                      className="btn secondary"
                      onClick={() => testSource(source)}
                      disabled={busy === `test-${source.id}`}
                      data-testid={`test-connection-${source.id}`}
                    >
                      {busy === `test-${source.id}` ? "Testing…" : "Test connection"}
                    </button>
                  )}
                  {source.is_active && source.source_type === "postgres" && (
                    <button
                      className="btn"
                      onClick={() => openImport(source)}
                      data-testid={`import-data-${source.id}`}
                    >
                      Import data
                    </button>
                  )}
                  {!source.is_active && (
                    <button
                      className="btn"
                      onClick={() => activateSource(source)}
                      disabled={busy === `activate-${source.id}`}
                      data-testid={`activate-${source.id}`}
                    >
                      {busy === `activate-${source.id}` ? "Activating…" : "Activate"}
                    </button>
                  )}
                  <button className="btn link" onClick={() => editSource(source)} data-testid={`edit-${source.id}`}>
                    Edit
                  </button>
                  {source.is_active && (
                    <button
                      className="btn link danger-text"
                      onClick={() => deactivateSource(source)}
                      disabled={busy === `deactivate-${source.id}`}
                      data-testid={`deactivate-${source.id}`}
                    >
                      Deactivate
                    </button>
                  )}
                  <button
                    className="btn link danger-text"
                    onClick={() => deleteSource(source)}
                    disabled={busy === `delete-${source.id}`}
                    data-testid={`delete-${source.id}`}
                  >
                    Delete permanently
                  </button>
                </div>
              )}
              {importingId === source.id && (
                <div className="panel form source-import-panel" data-testid={`import-panel-${source.id}`}>
                  <div className="panel-title">
                    <div>
                      <span className="eyebrow">Import</span>
                      <h3>Import from PostgreSQL</h3>
                    </div>
                    <button className="btn link" type="button" onClick={closeImport}>
                      Close
                    </button>
                  </div>
                  <div className="row-actions" role="tablist" aria-label="Import mode">
                    <button
                      type="button"
                      className={importState.mode === "table" ? "btn" : "btn secondary"}
                      onClick={() => setImportState((current) => ({ ...current, mode: "table" }))}
                      data-testid="import-mode-table"
                      disabled={importBusy}
                    >
                      Table
                    </button>
                    <button
                      type="button"
                      className={importState.mode === "sql" ? "btn" : "btn secondary"}
                      onClick={() => setImportState((current) => ({ ...current, mode: "sql" }))}
                      data-testid="import-mode-sql"
                      disabled={importBusy}
                    >
                      SQL Query
                    </button>
                  </div>
                  <label>
                    Dataset name
                    <input
                      value={importState.datasetName}
                      onChange={(event) =>
                        setImportState((current) => ({ ...current, datasetName: event.target.value }))
                      }
                      required
                      disabled={importBusy}
                      data-testid="import-dataset-name"
                    />
                  </label>
                  {importState.mode === "table" ? (
                    <>
                      <label>
                        Schema
                        <select
                          value={importState.schema}
                          onChange={(event) =>
                            setImportState((current) => ({
                              ...current,
                              schema: event.target.value,
                              table: "",
                            }))
                          }
                          disabled={importState.schemasLoading || importBusy}
                          data-testid="import-schema"
                        >
                          {importState.schemasLoading && <option value="">Loading schemas…</option>}
                          {!importState.schemasLoading && importState.schemas.length === 0 && (
                            <option value="">No schemas found</option>
                          )}
                          {importState.schemas.map((schema) => (
                            <option key={schema} value={schema}>
                              {schema}
                            </option>
                          ))}
                        </select>
                      </label>
                      {importState.schemasError && <ErrorNotice message={importState.schemasError} />}
                      <label>
                        Table
                        <select
                          value={importState.table}
                          onChange={(event) =>
                            setImportState((current) => ({
                              ...current,
                              table: event.target.value,
                              datasetName: suggestDatasetName(event.target.value) || current.datasetName,
                            }))
                          }
                          disabled={importState.tablesLoading || !importState.schema || importBusy}
                          data-testid="import-table"
                        >
                          {importState.tablesLoading && <option value="">Loading tables…</option>}
                          {!importState.tablesLoading && importState.tables.length === 0 && (
                            <option value="">No tables found</option>
                          )}
                          {importState.tables.map((table) => (
                            <option key={table.name} value={table.name}>
                              {table.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {importState.tablesError && <ErrorNotice message={importState.tablesError} />}
                    </>
                  ) : (
                    <label>
                      SQL Query
                      <textarea
                        className="code-input"
                        value={importState.sql}
                        onChange={(event) =>
                          setImportState((current) => ({ ...current, sql: event.target.value }))
                        }
                        spellCheck={false}
                        disabled={importBusy}
                        placeholder={"SELECT *\nFROM schema.table\nWHERE ..."}
                        data-testid="import-sql"
                      />
                      <small>Only read-only SELECT / WITH queries are supported.</small>
                    </label>
                  )}
                  <div className="row-actions">
                    <button
                      className="btn"
                      type="button"
                      onClick={() => submitImport(source)}
                      disabled={importBusy}
                      data-testid="import-submit"
                    >
                      {importState.submitting
                        ? "Starting…"
                        : importState.job?.status === "pending" || importState.job?.status === "running"
                          ? "Importing…"
                          : importState.job?.status === "failed"
                            ? "Retry import"
                            : "Start import"}
                    </button>
                  </div>
                  {importState.job && (
                    <div className="source-import-status" data-testid="import-status">
                      <p>
                        {importState.job.status === "succeeded"
                          ? `Import completed for “${importState.datasetName || "dataset"}”.`
                          : importState.job.status === "failed"
                            ? "Import failed."
                            : `Importing ${importState.datasetName || "dataset"}…`}
                      </p>
                      <p>
                        Status: <StatusBadge status={importState.job.status} />
                      </p>
                      {importState.job.error_message && (
                        <ErrorNotice message={importState.job.error_message} />
                      )}
                      {importState.job.status === "succeeded" && importState.job.dataset_id && (
                        <Link
                          className="btn"
                          to={`/projects/${projectId}/datasets/${importState.job.dataset_id}`}
                          data-testid="open-imported-dataset"
                        >
                          Open dataset
                        </Link>
                      )}
                    </div>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
