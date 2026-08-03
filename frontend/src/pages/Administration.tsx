import { type FormEvent, useEffect, useState } from "react";
import { api, type User } from "../api";
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

type SystemStatus = {
  api: string;
  version: string;
  database: string;
  minio: string;
  mlflow: string;
  healthy_worker_count: number;
  workers: Array<{ worker_id: string; healthy: boolean; last_seen_at: string }>;
  queue_depths: Record<string, Record<string, number>>;
  storage: Record<string, { object_count: number; bytes: number }> | null;
};
type Settings = {
  allow_train_on_quality_fail: boolean;
  store_inference_payloads: boolean;
  max_upload_bytes: number;
  rate_limit_per_minute: number;
  worker_max_concurrent_jobs: number;
};

export default function Administration() {
  const { user: currentUser } = useAuth();
  const [tab, setTab] = useState<"users" | "status" | "settings">("users");
  const [users, setUsers] = useState<User[]>([]);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [showUser, setShowUser] = useState(false);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [systemAdmin, setSystemAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function load() {
    setLoading(true);
    try {
      const [userPage, systemStatus, systemSettings] = await Promise.all([
        api<{ items: User[] }>("/users"),
        api<SystemStatus>("/admin/status"),
        api<Settings>("/admin/settings"),
      ]);
      setUsers(userPage.items);
      setStatus(systemStatus);
      setSettings(systemSettings);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Administration data could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api("/users", { method: "POST", body: JSON.stringify({ email, full_name: fullName, password, is_system_admin: systemAdmin }) });
      setSuccess("User created.");
      setEmail(""); setFullName(""); setPassword(""); setSystemAdmin(false); setShowUser(false);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "User could not be created.");
    }
  }

  async function toggleUser(user: User) {
    const action = user.is_active ? "deactivate" : "activate";
    if (action === "deactivate" && !confirmAction(`Deactivate ${user.email}? Their active sessions will end.`)) return;
    setError("");
    try {
      await api(`/users/${user.id}/${action}`, { method: "POST" });
      setSuccess(`User ${action}d.`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `User could not be ${action}d.`);
    }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (!settings) return;
    setError("");
    try {
      setSettings(await api<Settings>("/admin/settings", { method: "PUT", body: JSON.stringify({ values: settings }) }));
      setSuccess("System settings saved.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Settings could not be saved.");
    }
  }

  return <div>
    <PageHeader title="Administration" description="Manage users, system health, and workspace policies." />
    <ErrorNotice message={error} /><SuccessNotice message={success} />
    <div className="segmented admin-tabs"><button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>Users</button><button className={tab === "status" ? "active" : ""} onClick={() => setTab("status")}>System status</button><button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>Settings</button></div>
    {loading ? <Loading label="Loading administration" /> : tab === "users" ? <>
      <div className="section-heading"><div><span className="eyebrow">Identity</span><h2>{users.length} users</h2></div><button className="btn" onClick={() => setShowUser(!showUser)}>＋ Add user</button></div>
      {showUser && <form className="panel form" onSubmit={createUser}><label>Full name<input value={fullName} onChange={(event) => setFullName(event.target.value)} /></label><label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label>Temporary password<input type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required /></label><label className="checkbox-label"><input type="checkbox" checked={systemAdmin} onChange={(event) => setSystemAdmin(event.target.checked)} /> System administrator</label><div className="row-actions"><button className="btn">Create user</button><button type="button" className="btn secondary" onClick={() => setShowUser(false)}>Cancel</button></div></form>}
      <div className="panel table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Created</th><th /></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td><strong>{user.full_name || "Unnamed user"}</strong><small className="table-subtitle">{user.email}</small></td><td>{user.is_system_admin ? "System administrator" : "Member"}</td><td><StatusBadge status={user.is_active ? "active" : "inactive"} /></td><td>{formatDate(user.created_at)}</td><td><button className={`btn ${user.is_active ? "link danger-text" : "secondary"}`} disabled={user.id === currentUser?.id} onClick={() => toggleUser(user)}>{user.is_active ? "Deactivate" : "Activate"}</button></td></tr>)}</tbody></table></div>
    </> : tab === "status" && status ? <>
      <div className="grid stats-grid"><div className="stat"><div className="label">API</div><StatusBadge status={status.api} /><small>Version {status.version}</small></div><div className="stat"><div className="label">Database</div><StatusBadge status={status.database} /></div><div className="stat"><div className="label">Artifact storage</div><StatusBadge status={status.minio} /></div><div className="stat"><div className="label">Experiment tracking</div><StatusBadge status={status.mlflow} /></div></div>
      <div className="two-column">
        <section className="panel"><span className="eyebrow">Execution</span><h2>Training services</h2>{status.workers.length === 0 ? <EmptyState title="No execution service heartbeat" description="Training and asynchronous workflows are temporarily unavailable." /> : <div className="activity-list">{status.workers.map((worker) => <div key={worker.worker_id}><div><strong>{worker.worker_id}</strong><small>Last contact {formatDate(worker.last_seen_at)}</small></div><StatusBadge status={worker.healthy ? "healthy" : "unhealthy"} /></div>)}</div>}</section>
        <section className="panel"><span className="eyebrow">Capacity</span><h2>Queued work</h2><dl className="key-values">{Object.entries(status.queue_depths).map(([name, counts]) => <div key={name}><dt>{name.replaceAll("_", " ")}</dt><dd>{(counts.pending || 0) + (counts.running || 0)} active · {counts.failed || 0} failed</dd></div>)}</dl></section>
      </div>
    </> : tab === "settings" && settings ? <form className="panel form form-wide" onSubmit={saveSettings}>
      <div className="panel-title"><div><span className="eyebrow">Policies</span><h2>System settings</h2></div></div>
      <label className="toggle-row"><span><strong>Allow training after failed quality checks</strong><small>Project blocking rules will not prevent a job.</small></span><input type="checkbox" checked={settings.allow_train_on_quality_fail} onChange={(event) => setSettings({ ...settings, allow_train_on_quality_fail: event.target.checked })} /></label>
      <label className="toggle-row"><span><strong>Store prediction payloads</strong><small>Retain submitted feature values for monitoring.</small></span><input type="checkbox" checked={settings.store_inference_payloads} onChange={(event) => setSettings({ ...settings, store_inference_payloads: event.target.checked })} /></label>
      <div className="form-grid"><label>Maximum upload bytes<input type="number" min={1} value={settings.max_upload_bytes} onChange={(event) => setSettings({ ...settings, max_upload_bytes: Number(event.target.value) })} /></label><label>Requests per minute<input type="number" min={1} value={settings.rate_limit_per_minute} onChange={(event) => setSettings({ ...settings, rate_limit_per_minute: Number(event.target.value) })} /></label><label>Concurrent background jobs<input type="number" min={1} value={settings.worker_max_concurrent_jobs} onChange={(event) => setSettings({ ...settings, worker_max_concurrent_jobs: Number(event.target.value) })} /></label></div>
      <button className="btn">Save settings</button>
    </form> : null}
  </div>;
}
