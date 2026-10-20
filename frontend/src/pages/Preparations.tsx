import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiRequestError, api, type DatasetPreparation } from "../api";
import { useAuth } from "../AuthContext";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SuccessNotice,
  formatDate,
} from "../components";
import { emptyPreparationGraph } from "../preparationHelpers";
import { userCanProject, useProject } from "../ProjectContext";

export default function Preparations() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { selectedProject } = useProject();
  const [items, setItems] = useState<DatasetPreparation[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const canWrite = userCanProject(
    user,
    selectedProject,
    "DATA_SCIENTIST",
    "ML_ENGINEER",
    "PROJECT_ADMIN",
  );

  const refresh = useCallback(async () => {
    const data = await api<DatasetPreparation[]>(
      `/projects/${projectId}/dataset-preparations`,
    );
    setItems(data);
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    refresh().catch((reason) => {
      setLoading(false);
      setError(reason instanceof Error ? reason.message : "데이터 가공 목록을 불러오지 못했습니다.");
    });
  }, [refresh]);

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const created = await api<DatasetPreparation>(
        `/projects/${projectId}/dataset-preparations`,
        {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim(),
            graph: emptyPreparationGraph(),
          }),
        },
      );
      navigate(`/projects/${projectId}/preparations/${created.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "데이터 가공을 만들지 못했습니다.");
      setBusy(false);
    }
  }

  async function onDelete(preparation: DatasetPreparation) {
    if (!canWrite) return;
    if (!window.confirm(`“${preparation.name}” 데이터 가공을 삭제하시겠습니까?`)) return;
    setError("");
    setSuccess("");
    try {
      await api(`/projects/${projectId}/dataset-preparations/${preparation.id}`, {
        method: "DELETE",
      });
      setSuccess(`“${preparation.name}” 데이터 가공을 삭제했습니다.`);
      await refresh();
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.status === 409) {
        setError(reason.message);
      } else {
        setError(reason instanceof Error ? reason.message : "데이터 가공을 삭제하지 못했습니다.");
      }
    }
  }

  return (
    <div>
      <PageHeader
        title="데이터 가공"
        description="데이터 가공 그래프를 만들고 관리합니다. 여러 데이터셋을 결합·변환해 학습에 사용할 결과 데이터셋을 만들 수 있습니다."
        actions={
          canWrite ? (
            <button
              className="btn"
              type="button"
              data-testid="preparation-create-toggle"
              onClick={() => setShowCreate(!showCreate)}
            >
              ＋ 새 데이터 가공
            </button>
          ) : undefined
        }
      />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />
      {canWrite && showCreate && (
        <form className="panel form workflow-create-panel" onSubmit={onCreate} data-testid="preparation-create-form">
          <div className="panel-title">
            <div>
              <span className="eyebrow">새 데이터 가공</span>
              <h2>데이터 가공 만들기</h2>
            </div>
          </div>
          <label>
            이름
            <input
              name="name"
              value={name}
              required
              placeholder="예: 고객 특성 데이터 결합"
              data-testid="preparation-name"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            설명 (선택)
            <input
              name="description"
              value={description}
              placeholder="이 데이터 가공의 목적이나 결과를 입력하세요"
              data-testid="preparation-description"
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <div className="row-actions">
            <button className="btn" type="submit" disabled={busy} data-testid="preparation-create">
              {busy ? "생성 중…" : "생성 후 편집"}
            </button>
            <button className="btn secondary" type="button" onClick={() => setShowCreate(false)}>
              취소
            </button>
          </div>
        </form>
      )}
      {loading ? (
        <Loading label="데이터 가공 불러오는 중" />
      ) : items.length === 0 ? (
        <EmptyState
          title="데이터 가공이 없습니다"
          description="학습 전에 데이터셋을 결합·변환할 데이터 가공 그래프를 만들어 보세요."
          action={
            canWrite ? (
              <button className="btn" type="button" onClick={() => setShowCreate(true)}>
                새 데이터 가공
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="workflow-catalog">
          <div className="catalog-summary" aria-live="polite">
            <span className="catalog-summary-label">
              이 프로젝트의 데이터 가공{" "}
              <span className="catalog-summary-count">{items.length}</span>개
            </span>
          </div>
          <div className="panel table-wrap catalog-table">
            <table data-testid="preparations-table">
              <thead>
                <tr>
                  <th>데이터 가공명</th>
                  <th>최신 버전</th>
                  <th>결과 데이터셋</th>
                  <th>생성일시</th>
                  <th>
                    <span className="sr-only">작업</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((preparation) => (
                  <tr key={preparation.id} data-testid={`preparation-row-${preparation.id}`}>
                    <td>
                      <Link
                        className="catalog-primary-link"
                        to={`/projects/${projectId}/preparations/${preparation.id}`}
                      >
                        <strong>{preparation.name}</strong>
                      </Link>
                      <small className="table-subtitle">
                        {preparation.description || "설명 없음"}
                      </small>
                    </td>
                    <td>
                      <span className="version-chip" title="최신 데이터 가공 그래프 버전">
                        v{preparation.latest_version}
                      </span>
                    </td>
                    <td>
                      {preparation.output_dataset_id == null ? (
                        <span className="catalog-empty-meta">미설정</span>
                      ) : (
                        <span className="version-chip is-neutral" title="연결된 결과 데이터셋">
                          #{preparation.output_dataset_id}
                        </span>
                      )}
                    </td>
                    <td className="catalog-meta-date">{formatDate(preparation.created_at)}</td>
                    <td className="catalog-row-actions">
                      <div className="catalog-row-actions-inner">
                        <Link
                          className="btn link"
                          to={`/projects/${projectId}/preparations/${preparation.id}`}
                        >
                          열기
                        </Link>
                        {canWrite ? (
                          <button
                            type="button"
                            className="btn link danger-text"
                            data-testid={`preparation-delete-${preparation.id}`}
                            onClick={() => void onDelete(preparation)}
                          >
                            삭제
                          </button>
                        ) : null}
                      </div>
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
