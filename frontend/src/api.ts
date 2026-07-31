export type ApiError = { detail: string; hint?: string | null };

async function parseError(res: Response): Promise<never> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(res.statusText || "Request failed");
  }
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === "string") throw new Error(detail);
  if (detail && typeof detail === "object" && "detail" in (detail as object)) {
    const d = detail as ApiError;
    throw new Error(d.hint ? `${d.detail} — ${d.hint}` : d.detail);
  }
  throw new Error(JSON.stringify(detail));
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) await parseError(res);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export type Project = {
  id: number;
  name: string;
  description: string;
  created_at: string;
};

export type Dataset = {
  id: number;
  project_id: number;
  name: string;
  row_count: number;
  column_count: number;
  columns: string[];
  stats: Record<string, Record<string, unknown>>;
  created_at: string;
};

export type Job = {
  id: number;
  project_id: number;
  dataset_id: number;
  name: string;
  target_column: string;
  algorithm: string;
  hyperparameters: Record<string, unknown>;
  status: string;
  logs: string;
  mlflow_run_id: string | null;
  model_uri: string | null;
  metrics: Record<string, number>;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type Run = {
  run_id: string;
  experiment_id: string;
  status: string;
  start_time: number | null;
  end_time: number | null;
  params: Record<string, string>;
  metrics: Record<string, number>;
  artifact_uri: string | null;
  tags: Record<string, string>;
  artifacts?: { path: string; is_dir: boolean; file_size?: number }[];
};

export type ModelVersion = {
  name: string;
  version: string;
  status: string;
  run_id: string | null;
  source: string | null;
  creation_timestamp: number | null;
};

export type RegisteredModel = {
  name: string;
  latest_versions: ModelVersion[];
};

export type Endpoint = {
  id: number;
  project_id: number;
  name: string;
  model_name: string;
  model_version: string;
  model_uri: string;
  status: string;
  request_count: number;
  created_at: string;
};

export type SystemStatus = {
  api: string;
  database: string;
  minio: string;
  mlflow: string;
  pending_jobs: number;
  running_jobs: number;
};

export type DashboardStats = {
  projects: number;
  datasets: number;
  jobs: number;
  endpoints: number;
  succeeded_jobs: number;
  failed_jobs: number;
};
