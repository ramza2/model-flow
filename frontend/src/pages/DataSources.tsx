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
  DEFAULT_MYSQL_FORM,
  DEFAULT_MSSQL_FORM,
  DEFAULT_ORACLE_FORM,
  DEFAULT_POSTGRES_FORM,
  DEFAULT_REST_API_FORM,
  buildOracleSavePayload,
  buildPostgresSavePayload,
  buildRestApiSavePayload,
  extraPostgresConfig,
  mssqlFormFromConfig,
  mysqlFormFromConfig,
  oracleFormFromConfig,
  preferredOracleImportSchema,
  postgresFormFromConfig,
  resolvePostgresConnectionMode,
  restApiFormFromConfig,
  type PostgresConnectionMode,
  type RestApiAuthType,
} from "../dataSourceForm";
import { userCanProject, useProject } from "../ProjectContext";

type SqlSourceType = "postgres" | "mysql" | "mssql" | "oracle";
type SourceTypeOption = "file" | SqlSourceType | "rest_api";

function isSqlSourceType(value: string): value is SqlSourceType {
  return (
    value === "postgres" ||
    value === "mysql" ||
    value === "mssql" ||
    value === "oracle"
  );
}

function sqlSourceLabel(sourceType: string): string {
  if (sourceType === "mysql") return "MySQL / MariaDB";
  if (sourceType === "mssql") return "Microsoft SQL Server";
  if (sourceType === "oracle") return "Oracle Database";
  if (sourceType === "postgres") return "PostgreSQL";
  if (sourceType === "rest_api") return "REST API";
  return "Managed file source";
}

function defaultSqlForm(sourceType: SqlSourceType) {
  if (sourceType === "mysql") return DEFAULT_MYSQL_FORM;
  if (sourceType === "mssql") return DEFAULT_MSSQL_FORM;
  if (sourceType === "oracle") return DEFAULT_ORACLE_FORM;
  return DEFAULT_POSTGRES_FORM;
}

function sqlFormFromConfig(sourceType: SqlSourceType, config: Record<string, unknown>) {
  if (sourceType === "mysql") return mysqlFormFromConfig(config);
  if (sourceType === "mssql") return mssqlFormFromConfig(config);
  if (sourceType === "oracle") return oracleFormFromConfig(config);
  return postgresFormFromConfig(config);
}

type ImportMode = "table" | "sql" | "resource";

type ImportPanelState = {
  mode: ImportMode;
  schema: string;
  table: string;
  sql: string;
  resource: string;
  datasetName: string;
  schemas: string[];
  tables: { schema: string | null; name: string }[];
  schemasLoading: boolean;
  tablesLoading: boolean;
  schemasError: string;
  tablesError: string;
  preview: { columns: string[]; rows: Record<string, unknown>[] } | null;
  previewLoading: boolean;
  previewError: string;
  job: DataImportJob | null;
  submitting: boolean;
};

const emptyImportState = (): ImportPanelState => ({
  mode: "table",
  schema: "",
  table: "",
  sql: "",
  resource: "",
  datasetName: "",
  schemas: [],
  tables: [],
  schemasLoading: false,
  tablesLoading: false,
  schemasError: "",
  tablesError: "",
  preview: null,
  previewLoading: false,
  previewError: "",
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
  const [sourceType, setSourceType] = useState<SourceTypeOption>("postgres");
  const [config, setConfig] = useState("{}");
  const [postgresForm, setPostgresForm] = useState(DEFAULT_POSTGRES_FORM);
  const [postgresExtraConfig, setPostgresExtraConfig] = useState<Record<string, unknown>>({});
  const [password, setPassword] = useState("");
  const [connectionMode, setConnectionMode] = useState<PostgresConnectionMode>("host_port");
  const [connectionUrl, setConnectionUrl] = useState("");
  const [previousConnectionMode, setPreviousConnectionMode] =
    useState<PostgresConnectionMode | null>(null);
  const [restApiForm, setRestApiForm] = useState(DEFAULT_REST_API_FORM);
  const [bearerToken, setBearerToken] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [previousRestAuthType, setPreviousRestAuthType] =
    useState<RestApiAuthType | null>(null);
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
    setRestApiForm(DEFAULT_REST_API_FORM);
    setBearerToken("");
    setApiKey("");
    setPreviousRestAuthType(null);
    setShowForm(false);
  }

  function editSource(source: DataSource) {
    setEditing(source);
    setName(source.name);
    setSourceType(source.source_type);
    setConfig(JSON.stringify(source.config, null, 2));
    setPostgresForm(
      isSqlSourceType(source.source_type)
        ? sqlFormFromConfig(source.source_type, source.config)
        : DEFAULT_POSTGRES_FORM,
    );
    setPostgresExtraConfig(extraPostgresConfig(source.config));
    setPassword("");
    const mode = resolvePostgresConnectionMode(source.connection_mode);
    setConnectionMode(mode);
    setPreviousConnectionMode(mode);
    setConnectionUrl("");
    const restForm = restApiFormFromConfig(source.config);
    setRestApiForm(restForm);
    setBearerToken("");
    setApiKey("");
    setPreviousRestAuthType(source.source_type === "rest_api" ? restForm.authType : null);
    setShowForm(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy("save");
    setError("");
    setSuccess("");
    try {
      if (isSqlSourceType(sourceType)) {
        const payload =
          sourceType === "oracle"
            ? buildOracleSavePayload({
                mode: connectionMode,
                form: postgresForm,
                extra: postgresExtraConfig,
                password,
                connectionUrl,
                editing: Boolean(editing),
                previousMode: previousConnectionMode,
              })
            : buildPostgresSavePayload({
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
      } else if (sourceType === "rest_api") {
        const payload = buildRestApiSavePayload({
          form: restApiForm,
          bearerToken,
          apiKey,
          editing: Boolean(editing),
          previousAuthType: previousRestAuthType,
          hasSecrets: Boolean(editing?.has_secrets),
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
    void loadRecentJobs(source.id);

    if (source.source_type === "rest_api") {
      const resource = String(source.config.resource_path ?? "").trim() || "/";
      setImportState({
        ...next,
        mode: "resource",
        resource,
        datasetName: suggestDatasetName(resource.split("?")[0].split("/").filter(Boolean).pop() || "api-data"),
      });
      return;
    }

    setImportState(next);
    setImportState((current) => ({ ...current, schemasLoading: true, schemasError: "" }));
    try {
      const schemas = await api<string[]>(`/projects/${projectId}/data-sources/${source.id}/schemas`);
      const configuredDb = String(source.config.database ?? "").trim();
      const preferred =
        source.source_type === "oracle"
          ? preferredOracleImportSchema(schemas, String(source.config.user ?? ""))
          : source.source_type === "mysql" && configuredDb && schemas.includes(configuredDb)
            ? configuredDb
            : schemas.includes("dbo")
              ? "dbo"
              : schemas.includes("public")
                ? "public"
                : schemas[0] || "";
      setImportState((current) => ({
        ...current,
        schemas,
        schemasLoading: false,
        schema: preferred,
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

  async function previewRestResource(source: DataSource) {
    const resource = importState.resource.trim() || "/";
    setImportState((current) => ({
      ...current,
      previewLoading: true,
      previewError: "",
      preview: null,
    }));
    try {
      const preview = await api<{ columns: string[]; rows: Record<string, unknown>[] }>(
        `/projects/${projectId}/data-sources/${source.id}/preview?resource=${encodeURIComponent(resource)}&limit=10`,
      );
      setImportState((current) => ({
        ...current,
        preview,
        previewLoading: false,
      }));
    } catch (reason) {
      setImportState((current) => ({
        ...current,
        previewLoading: false,
        previewError:
          reason instanceof Error ? reason.message : "REST API preview could not be loaded.",
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
    if (source.source_type === "rest_api") {
      tableOrQuery = importState.resource.trim() || "/";
    } else if (importState.mode === "table") {
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
              onChange={(event) => {
                const next = event.target.value as SourceTypeOption;
                setSourceType(next);
                if (
                  next === "mysql" ||
                  next === "mssql" ||
                  next === "oracle" ||
                  next === "postgres"
                ) {
                  setPostgresForm(defaultSqlForm(next));
                  setPostgresExtraConfig({});
                  setConnectionMode("host_port");
                  setConnectionUrl("");
                  setPassword("");
                }
              }}
              data-testid="data-source-type"
            >
              <option value="postgres">PostgreSQL</option>
              <option value="mysql">MySQL / MariaDB</option>
              <option value="mssql">Microsoft SQL Server</option>
              <option value="oracle">Oracle Database</option>
              <option value="rest_api">REST API</option>
              <option value="file">Managed file source</option>
            </select>
          </label>
          {isSqlSourceType(sourceType) ? (
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
                        : sourceType === "mysql"
                          ? "mysql://user:password@host:3306/database"
                          : sourceType === "mssql"
                            ? "mssql://user:password@host:1433/database"
                            : sourceType === "oracle"
                              ? "oracle://user:password@host:1521/?service_name=FREEPDB1"
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
                    <label
                      htmlFor={
                        sourceType === "oracle"
                          ? "data-source-service-name"
                          : "data-source-database"
                      }
                    >
                      {sourceType === "oracle" ? "Service name" : "Database"}
                      <input
                        id={
                          sourceType === "oracle"
                            ? "data-source-service-name"
                            : "data-source-database"
                        }
                        value={postgresForm.database}
                        onChange={(event) =>
                          setPostgresForm((current) => ({
                            ...current,
                            database: event.target.value,
                          }))
                        }
                        required
                        autoComplete="off"
                        data-testid={
                          sourceType === "oracle"
                            ? "data-source-service-name"
                            : "data-source-database"
                        }
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
                  {sourceType === "mssql" && (
                    <label className="checkbox-row" htmlFor="data-source-trust-server-certificate">
                      <input
                        id="data-source-trust-server-certificate"
                        type="checkbox"
                        checked={Boolean(postgresExtraConfig.trust_server_certificate)}
                        onChange={(event) =>
                          setPostgresExtraConfig((current) => {
                            const next = { ...current };
                            if (event.target.checked) {
                              next.trust_server_certificate = true;
                            } else {
                              delete next.trust_server_certificate;
                            }
                            return next;
                          })
                        }
                        data-testid="data-source-trust-server-certificate"
                      />
                      Trust server certificate (lab / self-signed only)
                    </label>
                  )}
                </>
              )}
            </>
          ) : sourceType === "rest_api" ? (
            <>
              <label htmlFor="data-source-rest-base-url">
                Base URL
                <input
                  id="data-source-rest-base-url"
                  value={restApiForm.baseUrl}
                  onChange={(event) =>
                    setRestApiForm((current) => ({ ...current, baseUrl: event.target.value }))
                  }
                  required
                  placeholder="https://api.example.com/v1"
                  autoComplete="off"
                  data-testid="data-source-rest-base-url"
                />
              </label>
              <label htmlFor="data-source-rest-resource-path">
                Default resource path
                <input
                  id="data-source-rest-resource-path"
                  value={restApiForm.resourcePath}
                  onChange={(event) =>
                    setRestApiForm((current) => ({ ...current, resourcePath: event.target.value }))
                  }
                  placeholder="/customers"
                  autoComplete="off"
                  data-testid="data-source-rest-resource-path"
                />
                <small>GET only. Import can override this relative path without changing the source.</small>
              </label>
              <div className="form-grid">
                <label htmlFor="data-source-rest-data-path">
                  JSON data path
                  <input
                    id="data-source-rest-data-path"
                    value={restApiForm.dataPath}
                    onChange={(event) =>
                      setRestApiForm((current) => ({ ...current, dataPath: event.target.value }))
                    }
                    placeholder="data.items"
                    data-testid="data-source-rest-data-path"
                  />
                  <small>Optional dot path to the object array inside a wrapped JSON response.</small>
                </label>
                <label htmlFor="data-source-rest-timeout">
                  Timeout (seconds)
                  <input
                    id="data-source-rest-timeout"
                    type="number"
                    min={1}
                    max={60}
                    value={restApiForm.timeoutSeconds}
                    onChange={(event) =>
                      setRestApiForm((current) => ({
                        ...current,
                        timeoutSeconds: event.target.value,
                      }))
                    }
                    required
                    data-testid="data-source-rest-timeout"
                  />
                </label>
              </div>
              <label htmlFor="data-source-rest-auth-type">
                Authentication
                <select
                  id="data-source-rest-auth-type"
                  value={restApiForm.authType}
                  onChange={(event) =>
                    setRestApiForm((current) => ({
                      ...current,
                      authType: event.target.value as RestApiAuthType,
                    }))
                  }
                  data-testid="data-source-rest-auth-type"
                >
                  <option value="none">None</option>
                  <option value="bearer">Bearer token</option>
                  <option value="api_key">API key header</option>
                </select>
              </label>
              {restApiForm.authType === "bearer" && (
                <label htmlFor="data-source-rest-bearer-token">
                  Bearer token
                  <input
                    id="data-source-rest-bearer-token"
                    type="password"
                    autoComplete="new-password"
                    value={bearerToken}
                    onChange={(event) => setBearerToken(event.target.value)}
                    placeholder={
                      editing?.has_secrets && previousRestAuthType === "bearer"
                        ? "Leave blank to keep saved token"
                        : "Bearer token"
                    }
                    data-testid="data-source-rest-bearer-token"
                  />
                  <small>The saved token is encrypted and never returned by the API.</small>
                </label>
              )}
              {restApiForm.authType === "api_key" && (
                <div className="form-grid">
                  <label htmlFor="data-source-rest-api-key-header">
                    API key header
                    <input
                      id="data-source-rest-api-key-header"
                      value={restApiForm.apiKeyHeader}
                      onChange={(event) =>
                        setRestApiForm((current) => ({
                          ...current,
                          apiKeyHeader: event.target.value,
                        }))
                      }
                      required
                      data-testid="data-source-rest-api-key-header"
                    />
                  </label>
                  <label htmlFor="data-source-rest-api-key">
                    API key
                    <input
                      id="data-source-rest-api-key"
                      type="password"
                      autoComplete="new-password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={
                        editing?.has_secrets && previousRestAuthType === "api_key"
                          ? "Leave blank to keep saved API key"
                          : "API key"
                      }
                      data-testid="data-source-rest-api-key"
                    />
                  </label>
                </div>
              )}
              <label htmlFor="data-source-rest-query-params">
                Query parameters
                <textarea
                  id="data-source-rest-query-params"
                  className="code-input"
                  value={restApiForm.queryParams}
                  onChange={(event) =>
                    setRestApiForm((current) => ({ ...current, queryParams: event.target.value }))
                  }
                  spellCheck={false}
                  data-testid="data-source-rest-query-params"
                />
                <small>Optional non-secret JSON object appended to every REST request.</small>
              </label>
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
          description="Add PostgreSQL, MySQL / MariaDB, Microsoft SQL Server, Oracle Database, or a REST API source, or use direct dataset upload to bring data into ModelFlow."
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
                  {isSqlSourceType(source.source_type)
                    ? "▥"
                    : source.source_type === "rest_api"
                      ? "⇄"
                      : "▤"}
                </span>
                <StatusBadge status={source.is_active ? source.last_test_status || "active" : "inactive"} />
              </div>
              <h2>{source.name}</h2>
              <p className="muted">
                {source.source_type === "postgres"
                  ? "PostgreSQL database"
                  : source.source_type === "mysql"
                    ? "MySQL / MariaDB database"
                    : source.source_type === "mssql"
                      ? "Microsoft SQL Server database"
                      : source.source_type === "oracle"
                        ? "Oracle Database"
                        : source.source_type === "rest_api"
                          ? "REST API"
                          : "Managed file source"}
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
                  {source.is_active &&
                    (isSqlSourceType(source.source_type) || source.source_type === "rest_api") && (
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
                      <h3>
                        {source.source_type === "rest_api"
                          ? "Import from REST API"
                          : `Import from ${sqlSourceLabel(source.source_type)}`}
                      </h3>
                    </div>
                    <button className="btn link" type="button" onClick={closeImport}>
                      Close
                    </button>
                  </div>
                  {isSqlSourceType(source.source_type) && (
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
                  )}
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
                  {source.source_type === "rest_api" ? (
                    <>
                      <label>
                        Resource path
                        <input
                          value={importState.resource}
                          onChange={(event) =>
                            setImportState((current) => ({
                              ...current,
                              resource: event.target.value,
                              preview: null,
                              previewError: "",
                            }))
                          }
                          placeholder="/customers?status=active"
                          disabled={importBusy}
                          data-testid="import-rest-resource"
                        />
                        <small>Relative GET path under the configured Base URL.</small>
                      </label>
                      <div className="row-actions">
                        <button
                          className="btn secondary"
                          type="button"
                          onClick={() => previewRestResource(source)}
                          disabled={importBusy || importState.previewLoading}
                          data-testid="import-rest-preview"
                        >
                          {importState.previewLoading ? "Loading preview…" : "Preview response"}
                        </button>
                      </div>
                      {importState.previewError && <ErrorNotice message={importState.previewError} />}
                      {importState.preview && (
                        <div className="table-wrap" data-testid="import-rest-preview-table">
                          <table>
                            <thead>
                              <tr>
                                {importState.preview.columns.map((column) => (
                                  <th key={column}>{column}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {importState.preview.rows.map((row, index) => (
                                <tr key={index}>
                                  {importState.preview!.columns.map((column) => (
                                    <td key={column}>{String(row[column] ?? "")}</td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  ) : importState.mode === "table" ? (
                    <>
                      <label>
                        {source.source_type === "mysql" ? "Database" : "Schema"}
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
