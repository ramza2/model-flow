import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Dataset } from "../api";
import { useAuth } from "../AuthContext";
import { EmptyState, ErrorNotice, Loading, PageHeader, SuccessNotice, formatDate } from "../components";
import { userCanProject, useProject } from "../ProjectContext";

export default function Datasets() {
  const { projectId } = useParams();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [items, setItems] = useState<Dataset[]>([]);
  const [showUpload, setShowUpload] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const canWrite = userCanProject(user, selectedProject, "DATA_SCIENTIST", "ML_ENGINEER", "PROJECT_ADMIN");

  const refresh = useCallback(async () => {
    const data = await api<Dataset[]>(`/projects/${projectId}/datasets`);
    setItems(data);
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    refresh().catch((reason) => {
      setLoading(false);
      setError(reason instanceof Error ? reason.message : "데이터셋을 불러오지 못했습니다.");
    });
  }, [refresh]);

  async function onUpload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fileInput = form.elements.namedItem("file") as HTMLInputElement;
    if (!fileInput.files?.[0]) return;
    const fd = new FormData();
    fd.append("file", fileInput.files[0]);
    const nameInput = form.elements.namedItem("name") as HTMLInputElement;
    const descriptionInput = form.elements.namedItem("description") as HTMLInputElement;
    if (nameInput.value) fd.append("name", nameInput.value);
    if (descriptionInput.value) fd.append("description", descriptionInput.value);
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api(`/projects/${projectId}/datasets`, { method: "POST", body: fd });
      form.reset();
      await refresh();
      setShowUpload(false);
      setSuccess("데이터셋을 업로드하고 데이터 특성을 분석했습니다.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "데이터셋 업로드에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="데이터셋"
        description="버전별 데이터셋을 확인하고 상세 화면에서 최신 데이터셋 버전(DatasetVersion)을 살펴보세요."
        actions={canWrite ? <button className="btn" onClick={() => setShowUpload(!showUpload)}>↑ 데이터셋 업로드</button> : undefined}
      />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      {showUpload && (
        <form className="panel form workflow-create-panel" onSubmit={onUpload}>
          <div className="panel-title"><div><span className="eyebrow">새 버전</span><h2>데이터 업로드</h2></div></div>
          <label>
            파일
            <input type="file" name="file" accept=".csv,.json,.parquet,text/csv,application/json" required data-testid="dataset-file" />
            <small>CSV·JSON·Parquet 파일을 업로드합니다. 기존 데이터를 변경하지 않고 새 데이터셋 버전을 생성합니다.</small>
          </label>
          <label>이름 (선택)<input name="name" placeholder="미입력 시 파일 이름 사용" /></label>
          <label>설명 (선택)<input name="description" placeholder="데이터 출처와 사용 목적" /></label>
          <div className="row-actions">
            <button className="btn" type="submit" disabled={busy} data-testid="dataset-upload">
              {busy ? "업로드 중…" : "업로드 및 분석"}
            </button>
            <button className="btn secondary" type="button" onClick={() => setShowUpload(false)}>취소</button>
          </div>
        </form>
      )}
      {loading ? <Loading label="데이터셋 불러오는 중" /> : items.length === 0 ? (
        <EmptyState
          title="등록된 데이터셋이 없습니다"
          description="파일을 업로드하거나 연결된 데이터 소스에서 데이터를 가져오세요."
          action={canWrite ? <button className="btn" onClick={() => setShowUpload(true)}>데이터셋 업로드</button> : undefined}
        />
      ) : (
        <div className="workflow-catalog">
          <div className="catalog-summary" aria-live="polite">
            <span className="catalog-summary-count">{items.length}</span>
            <span className="catalog-summary-label">
              {`이 프로젝트의 데이터셋 ${items.length}개`}
            </span>
          </div>
          <div className="panel table-wrap catalog-table">
            <table>
              <thead>
                <tr>
                  <th>데이터셋</th>
                  <th>최신 버전</th>
                  <th>행 수</th>
                  <th>컬럼 수</th>
                  <th>최근 수정</th>
                </tr>
              </thead>
              <tbody>
                {items.map((dataset) => (
                  <tr key={dataset.id}>
                    <td>
                      <Link
                        className="catalog-primary-link"
                        to={`/projects/${projectId}/datasets/${dataset.id}`}
                      >
                        <strong>{dataset.name}</strong>
                      </Link>
                      <small className="table-subtitle">
                        {dataset.description || "업로드한 데이터셋"}
                      </small>
                    </td>
                    <td>
                      <span className="version-chip" title="기존 내용이 변경되지 않는 최신 데이터셋 버전">
                        v{dataset.latest_version}
                      </span>
                    </td>
                    <td className="tabular-num">{dataset.row_count.toLocaleString()}</td>
                    <td className="tabular-num">{dataset.column_count}</td>
                    <td className="catalog-meta-date">
                      {formatDate(dataset.latest_version_created_at ?? dataset.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
