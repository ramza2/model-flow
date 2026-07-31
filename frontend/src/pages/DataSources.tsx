import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type DataSource } from "../api";
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

export default function DataSources() {
  const { projectId } = useParams();
  const [sources, setSources] = useState<DataSource[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<DataSource | null>(null);
  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<"file" | "postgres">("postgres");
  const [config, setConfig] = useState('{\n  "host": "postgres",\n  "port": 5432,\n  "database": "modelflow",\n  "user": "modelflow"\n}');
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

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

  function resetForm() {
    setEditing(null);
    setName("");
    setSourceType("postgres");
    setConfig('{\n  "host": "postgres",\n  "port": 5432,\n  "database": "modelflow",\n  "user": "modelflow"\n}');
    setPassword("");
    setShowForm(false);
  }

  function editSource(source: DataSource) {
    setEditing(source);
    setName(source.name);
    setSourceType(source.source_type);
    setConfig(JSON.stringify(source.config, null, 2));
    setPassword("");
    setShowForm(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy("save");
    setError("");
    setSuccess("");
    try {
      const parsed = JSON.parse(config) as Record<string, unknown>;
      const secrets = password ? { password } : {};
      if (editing) {
        await api(`/projects/${projectId}/data-sources/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name, config: parsed, secrets }),
        });
        setSuccess("Data source updated.");
      } else {
        await api(`/projects/${projectId}/data-sources`, {
          method: "POST",
          body: JSON.stringify({ name, source_type: sourceType, config: parsed, secrets }),
        });
        setSuccess("Data source created.");
      }
      resetForm();
      await load();
    } catch (reason) {
      setError(reason instanceof SyntaxError ? "Configuration must be valid JSON." : reason instanceof Error ? reason.message : "Data source could not be saved.");
    } finally {
      setBusy("");
    }
  }

  async function testSource(source: DataSource) {
    setBusy(`test-${source.id}`);
    setError("");
    try {
      const result = await api<{ status: string; message: string }>(
        `/projects/${projectId}/data-sources/${source.id}/test`,
        { method: "POST" },
      );
      setSuccess(result.message);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Connection test failed.");
    } finally {
      setBusy("");
    }
  }

  async function deactivate(source: DataSource) {
    if (!confirmAction(`Deactivate “${source.name}”? Existing imported datasets are not removed.`)) return;
    try {
      await api(`/projects/${projectId}/data-sources/${source.id}`, { method: "DELETE" });
      setSuccess("Data source deactivated.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Data source could not be deactivated.");
    }
  }

  return (
    <div>
      <PageHeader
        title="Data Sources"
        description="Connect managed data systems without exposing credentials in the interface."
        actions={<button className="btn" onClick={() => setShowForm(!showForm)}>＋ Add data source</button>}
      />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      {showForm && (
        <form className="panel form" onSubmit={save}>
          <div className="panel-title"><div><span className="eyebrow">Connection</span><h2>{editing ? "Edit data source" : "New data source"}</h2></div></div>
          <label>Name<input value={name} onChange={(event) => setName(event.target.value)} required placeholder="Analytics warehouse" /></label>
          <label>Source type<select value={sourceType} disabled={Boolean(editing)} onChange={(event) => setSourceType(event.target.value as "file" | "postgres")}>
            <option value="postgres">PostgreSQL</option>
            <option value="file">Managed file source</option>
          </select></label>
          <label>Configuration<textarea className="code-input" value={config} onChange={(event) => setConfig(event.target.value)} spellCheck={false} /><small>Connection metadata is visible to project members. Put passwords below.</small></label>
          {sourceType === "postgres" && <label>Password<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={editing?.has_secrets ? "Leave blank to keep saved password" : "Database password"} /></label>}
          <div className="row-actions">
            <button className="btn" disabled={busy === "save"}>{busy === "save" ? "Saving…" : "Save data source"}</button>
            <button className="btn secondary" type="button" onClick={resetForm}>Cancel</button>
          </div>
        </form>
      )}
      {loading ? <Loading label="Loading data sources" /> : sources.length === 0 ? (
        <EmptyState title="No connected data sources" description="Add PostgreSQL or use direct dataset upload to bring data into ModelFlow." action={<button className="btn" onClick={() => setShowForm(true)}>Add data source</button>} />
      ) : (
        <div className="card-grid">
          {sources.map((source) => (
            <article className="source-card" key={source.id}>
              <div className="project-card-top">
                <span className="source-icon" aria-hidden="true">{source.source_type === "postgres" ? "▥" : "▤"}</span>
                <StatusBadge status={source.is_active ? source.last_test_status || "active" : "inactive"} />
              </div>
              <h2>{source.name}</h2>
              <p className="muted">{source.source_type === "postgres" ? "PostgreSQL database" : "Managed file source"}</p>
              <dl className="key-values">
                {Object.entries(source.config).slice(0, 4).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}
                <div><dt>Last tested</dt><dd>{formatDate(source.last_tested_at)}</dd></div>
              </dl>
              {source.last_test_message && <p className="source-message">{source.last_test_message}</p>}
              <div className="row-actions">
                <button className="btn secondary" onClick={() => testSource(source)} disabled={!source.is_active || busy === `test-${source.id}`}>{busy === `test-${source.id}` ? "Testing…" : "Test connection"}</button>
                <button className="btn link" onClick={() => editSource(source)}>Edit</button>
                {source.is_active && <button className="btn link danger-text" onClick={() => deactivate(source)}>Deactivate</button>}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
