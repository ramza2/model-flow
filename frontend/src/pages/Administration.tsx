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
import { operationalStatusLabel } from "../uiTerminology";

const QUEUE_LABELS: Record<string, string> = {
  training: "모델 학습", data_import: "데이터 가져오기", pipeline: "파이프라인",
  batch_inference: "일괄 예측", drift: "데이터 변화 감지",
};

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
type BackupRetention = {
  enabled: boolean;
  days: number;
  minimum_verified_keep: number;
};

export default function Administration() {
  const { user: currentUser } = useAuth();
  const [tab, setTab] = useState<"users" | "status" | "settings">("users");
  const [users, setUsers] = useState<User[]>([]);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [backupRetention, setBackupRetention] = useState<BackupRetention | null>(null);
  const [savedBackupRetention, setSavedBackupRetention] = useState<BackupRetention | null>(null);
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
      try {
        const retention = await api<BackupRetention>("/admin/backup-retention");
        setBackupRetention(retention);
        setSavedBackupRetention(retention);
      } catch {
        setBackupRetention(null);
        setError("백업 보존 정책을 불러오지 못했습니다. 나머지 시스템 관리 기능은 사용할 수 있습니다.");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "시스템 관리 정보를 불러오지 못했습니다.");
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
      setSuccess("사용자를 등록했습니다.");
      setEmail(""); setFullName(""); setPassword(""); setSystemAdmin(false); setShowUser(false);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "사용자를 등록하지 못했습니다.");
    }
  }

  async function toggleUser(user: User) {
    const action = user.is_active ? "deactivate" : "activate";
    if (action === "deactivate" && !confirmAction(`${user.email} 사용자를 비활성화하시겠습니까? 현재 로그인 세션이 종료됩니다.`)) return;
    setError("");
    try {
      await api(`/users/${user.id}/${action}`, { method: "POST" });
      setSuccess(action === "deactivate" ? "사용자를 비활성화했습니다." : "사용자를 활성화했습니다.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "사용자 상태를 변경하지 못했습니다.");
    }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (!settings) return;
    setError("");
    try {
      setSettings(await api<Settings>("/admin/settings", { method: "PUT", body: JSON.stringify({ values: settings }) }));
      setSuccess("시스템 설정을 저장했습니다.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "시스템 설정을 저장하지 못했습니다.");
    }
  }

  async function saveBackupRetention(event: FormEvent) {
    event.preventDefault();
    if (!backupRetention || !Number.isInteger(backupRetention.days) || backupRetention.days < 7 || backupRetention.days > 365) {
      setError("백업 보존 기간은 7~365일 사이의 정수로 입력해 주세요.");
      return;
    }
    const newlyEnabled = backupRetention.enabled && !savedBackupRetention?.enabled;
    const shorterPeriod = backupRetention.enabled && savedBackupRetention && backupRetention.days < savedBackupRetention.days;
    if ((newlyEnabled || shorterPeriod) && !confirmAction("자동 백업 정리 정책을 변경하시겠습니까? 다음 예약 백업 성공 후 기존 조건에 맞는 검증 완료 백업이 정리될 수 있습니다.")) return;
    setError("");
    try {
      const saved = await api<BackupRetention>("/admin/backup-retention", {
        method: "PUT",
        body: JSON.stringify({ enabled: backupRetention.enabled, days: backupRetention.days }),
      });
      setBackupRetention(saved);
      setSavedBackupRetention(saved);
      setSuccess("자동 백업 보존 정책을 저장했습니다. 다음 예약 백업부터 적용됩니다.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "자동 백업 보존 정책을 저장하지 못했습니다.");
    }
  }

  return (
    <div>
      <PageHeader title="시스템 관리" description="사용자, 서비스 상태 및 시스템 운영 설정을 관리합니다." />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      <div className="segmented admin-tabs">
        <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>사용자 관리</button>
        <button className={tab === "status" ? "active" : ""} onClick={() => setTab("status")}>시스템 상태</button>
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>환경 설정</button>
      </div>
      {loading ? <Loading label="시스템 관리 정보 불러오는 중" /> : tab === "users" ? (
        <>
          <div className="section-heading">
            <div><span className="eyebrow">계정</span><h2>사용자 {users.length}명</h2></div>
            <button className="btn" onClick={() => setShowUser(!showUser)}>＋ 사용자 추가</button>
          </div>
          {showUser && (
            <form className="panel form" onSubmit={createUser}>
              <label>이름<input value={fullName} onChange={(event) => setFullName(event.target.value)} /></label>
              <label>이메일<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
              <label>임시 비밀번호<input type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
              <label className="checkbox-label"><input type="checkbox" checked={systemAdmin} onChange={(event) => setSystemAdmin(event.target.checked)} /> 시스템 관리자 권한</label>
              <div className="row-actions">
                <button className="btn">사용자 등록</button>
                <button type="button" className="btn secondary" onClick={() => setShowUser(false)}>취소</button>
              </div>
            </form>
          )}
          <div className="panel table-wrap">
            <table>
              <thead><tr><th>사용자</th><th>권한</th><th>상태</th><th>등록일</th><th /></tr></thead>
              <tbody>{users.map((user) => (
                <tr key={user.id}>
                  <td><strong>{user.full_name || "이름 미입력"}</strong><small className="table-subtitle">{user.email}</small></td>
                  <td>{user.is_system_admin ? "시스템 관리자" : "일반 사용자"}</td>
                  <td><StatusBadge status={user.is_active ? "active" : "inactive"} label={user.is_active ? "활성" : "비활성"} /></td>
                  <td>{formatDate(user.created_at)}</td>
                  <td><button className={`btn ${user.is_active ? "link danger-text" : "secondary"}`} disabled={user.id === currentUser?.id} onClick={() => toggleUser(user)}>{user.is_active ? "비활성화" : "활성화"}</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      ) : tab === "status" && status ? (
        <>
          <div className="grid stats-grid">
            <div className="stat"><div className="label">API</div><StatusBadge status={status.api} label={operationalStatusLabel(status.api)} /><small>버전 {status.version}</small></div>
            <div className="stat"><div className="label">데이터베이스</div><StatusBadge status={status.database} label={operationalStatusLabel(status.database)} /></div>
            <div className="stat"><div className="label">파일 저장소</div><StatusBadge status={status.minio} label={operationalStatusLabel(status.minio)} /></div>
            <div className="stat"><div className="label">실험 추적 서비스</div><StatusBadge status={status.mlflow} label={operationalStatusLabel(status.mlflow)} /></div>
          </div>
          <div className="two-column">
            <section className="panel">
              <span className="eyebrow">실행 서비스</span><h2>백그라운드 작업 처리</h2>
              {status.workers.length === 0 ? <EmptyState title="실행 서비스의 상태 정보가 없습니다" description="학습 및 비동기 작업을 일시적으로 수행할 수 없습니다." /> : (
                <div className="activity-list">{status.workers.map((worker) => (
                  <div key={worker.worker_id}>
                    <div><strong>{worker.worker_id}</strong><small>마지막 연결 {formatDate(worker.last_seen_at)}</small></div>
                    <StatusBadge status={worker.healthy ? "healthy" : "unhealthy"} label={worker.healthy ? "정상" : "비정상"} />
                  </div>
                ))}</div>
              )}
            </section>
            <section className="panel">
              <span className="eyebrow">작업 현황</span><h2>작업 대기열</h2>
              <dl className="key-values">{Object.entries(status.queue_depths).map(([name, counts]) => (
                <div key={name}><dt>{QUEUE_LABELS[name] || name.replaceAll("_", " ")}</dt><dd>진행·대기 {(counts.pending || 0) + (counts.running || 0)}건 · 실패 {counts.failed || 0}건</dd></div>
              ))}</dl>
            </section>
          </div>
        </>
      ) : tab === "settings" && settings ? (
        <>
        <form className="panel form form-wide" onSubmit={saveSettings}>
          <div className="panel-title"><div><span className="eyebrow">운영 정책</span><h2>시스템 환경 설정</h2></div></div>
          <label className="toggle-row">
            <span><strong>데이터 품질 검사에 실패해도 학습 허용</strong><small>이 옵션을 켜면 프로젝트의 품질 차단 규칙을 통과하지 못해도 학습 작업을 시작할 수 있습니다.</small></span>
            <input type="checkbox" checked={settings.allow_train_on_quality_fail} onChange={(event) => setSettings({ ...settings, allow_train_on_quality_fail: event.target.checked })} />
          </label>
          <label className="toggle-row">
            <span><strong>예측 요청의 입력값 저장</strong><small>모니터링을 위해 예측 요청에 사용된 입력 데이터를 보관합니다.</small></span>
            <input type="checkbox" checked={settings.store_inference_payloads} onChange={(event) => setSettings({ ...settings, store_inference_payloads: event.target.checked })} />
          </label>
          <div className="form-grid">
            <label>최대 파일 업로드 크기(바이트)<input type="number" min={1} value={settings.max_upload_bytes} onChange={(event) => setSettings({ ...settings, max_upload_bytes: Number(event.target.value) })} /></label>
            <label>분당 요청 제한<input type="number" min={1} value={settings.rate_limit_per_minute} onChange={(event) => setSettings({ ...settings, rate_limit_per_minute: Number(event.target.value) })} /></label>
            <label>동시 백그라운드 작업 수<input type="number" min={1} value={settings.worker_max_concurrent_jobs} onChange={(event) => setSettings({ ...settings, worker_max_concurrent_jobs: Number(event.target.value) })} /></label>
          </div>
          <button className="btn">환경 설정 저장</button>
        </form>
        {backupRetention ? (
          <form className="panel form form-wide" onSubmit={saveBackupRetention} data-testid="backup-retention-form">
            <div className="panel-title"><div><span className="eyebrow">자동 백업</span><h2>검증 완료 백업 보존 정책</h2></div></div>
            <p className="muted">매일 03:00(KST) 백업에 성공한 후, 지정한 기간이 지난 검증 완료 자동 백업만 정리합니다. 정책을 저장하는 즉시 파일을 삭제하지는 않습니다.</p>
            <label className="toggle-row">
              <span><strong>오래된 자동 백업 정리 사용</strong><small>운영 서버의 예약 작업에 정리 실행 옵션(--apply-retention)이 활성화되어 있어야 실제 정리됩니다.</small></span>
              <input type="checkbox" checked={backupRetention.enabled} onChange={(event) => setBackupRetention({ ...backupRetention, enabled: event.target.checked })} data-testid="backup-retention-enabled" />
            </label>
            <div className="form-grid">
              <label>검증 완료 백업 보존 기간(일)
                <input type="number" min={7} max={365} step={1} required value={backupRetention.days} onChange={(event) => setBackupRetention({ ...backupRetention, days: Number(event.target.value) })} data-testid="backup-retention-days" />
              </label>
            </div>
            <p className="muted">기본값 14일 · 허용 범위 7~365일 · 기간과 관계없이 최신 검증 완료 자동 백업 {backupRetention.minimum_verified_keep}개는 항상 보호합니다. 수동 백업 및 검증되지 않은 백업은 자동 정리 대상이 아닙니다.</p>
            <button className="btn" data-testid="backup-retention-save">백업 보존 정책 저장</button>
          </form>
        ) : null}
        </>
      ) : null}
    </div>
  );
}
