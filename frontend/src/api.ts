export const API_BASE = "/api/v1";
export const TOKEN_KEY = "modelflow_token";

type ErrorEnvelope = {
  detail?: string | { detail?: string; hint?: string | null };
  hint?: string | null;
};

export class ApiRequestError extends Error {
  status: number;
  hint?: string | null;

  constructor(status: number, message: string, hint?: string | null) {
    super(hint ? `${message} — ${hint}` : message);
    this.name = "ApiRequestError";
    this.status = status;
    this.hint = hint;
  }
}

async function parseError(response: Response): Promise<never> {
  let body: ErrorEnvelope = {};
  try {
    body = (await response.json()) as ErrorEnvelope;
  } catch {
    throw new ApiRequestError(
      response.status,
      response.statusText || "The request could not be completed.",
    );
  }
  const nested = typeof body.detail === "object" ? body.detail : undefined;
  const detail =
    typeof body.detail === "string"
      ? body.detail
      : nested?.detail || response.statusText || "The request could not be completed.";
  throw new ApiRequestError(response.status, detail, nested?.hint ?? body.hint);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const normalized = path.startsWith("/") ? path : `/${path}`;
  const response = await fetch(`${API_BASE}${normalized}`, { ...init, headers });
  if (response.status === 401 && normalized !== "/auth/login") {
    localStorage.removeItem(TOKEN_KEY);
    window.dispatchEvent(new Event("modelflow:unauthorized"));
  }
  if (!response.ok) await parseError(response);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function jsonBody(value: unknown): Pick<RequestInit, "body"> {
  return { body: JSON.stringify(value) };
}

export type User = {
  id: number;
  email: string;
  full_name: string;
  is_active: boolean;
  is_system_admin: boolean;
  created_at: string;
  updated_at: string;
};

export type AuthResponse = {
  access_token: string;
  token_type: string;
  user: User;
};

export type ProjectRole =
  | "VIEWER"
  | "DATA_SCIENTIST"
  | "ML_ENGINEER"
  | "PROJECT_ADMIN";

export type Project = {
  id: number;
  name: string;
  description: string;
  is_active: boolean;
  role: ProjectRole;
  created_at: string;
};

export type Membership = {
  id: number;
  project_id: number;
  user_id: number;
  email: string;
  full_name: string;
  role: ProjectRole;
  created_at: string;
};

export type DataSourceConnectionMode = "host_port" | "connection_url" | null;

export type DataSource = {
  id: number;
  project_id: number;
  name: string;
  source_type: "file" | "postgres";
  config: Record<string, unknown>;
  has_secrets: boolean;
  /** Non-sensitive hint; never includes secret values. Null for non-postgres sources. */
  connection_mode: DataSourceConnectionMode;
  is_active: boolean;
  last_test_status: string | null;
  last_test_message: string | null;
  last_tested_at: string | null;
  created_at: string;
};

export type DataImportJob = {
  id: number;
  project_id: number;
  data_source_id: number;
  dataset_id: number | null;
  dataset_version_id: number | null;
  table_or_query: string;
  status: string;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
};

export type Dataset = {
  id: number;
  project_id: number;
  name: string;
  description: string;
  latest_version: number;
  row_count: number;
  column_count: number;
  columns: string[];
  stats: Record<string, Record<string, unknown>>;
  created_at: string;
  latest_version_created_at?: string;
};

export type DatasetVersion = {
  id: number;
  dataset_id: number;
  project_id: number;
  version: number;
  original_filename: string;
  format: string;
  row_count: number;
  column_count: number;
  columns: string[];
  dtypes: Record<string, string>;
  stats: Record<string, Record<string, unknown>>;
  source_type: string;
  created_at: string;
};

export type DatasetSplit = {
  id: number;
  name: string;
  dataset_version_id: number;
  train_ratio: number;
  val_ratio: number;
  test_ratio: number;
  random_seed: number;
  config_signature?: string;
  hashes?: {
    train: string | null;
    validation: string | null;
    test: string | null;
  };
  created_at: string;
};

export type QualityRule = {
  id: number;
  project_id: number;
  dataset_id: number | null;
  dataset_name: string | null;
  name: string;
  rules: Array<Record<string, unknown>>;
  block_training_on_fail: boolean;
  is_active: boolean;
  created_at: string;
};

export type QualityCheckDetail = {
  quality_rule_id?: number;
  quality_rule_name?: string;
  rule?: Record<string, unknown>;
  severity?: string;
  block_training_on_fail?: boolean;
  passed?: boolean;
  message?: string;
};

export type QualityCheck = {
  id: number;
  project_id?: number;
  dataset_version_id: number;
  quality_rule_id?: number | null;
  result: string;
  details: QualityCheckDetail[];
  created_at: string;
};

export type Job = {
  id: number;
  project_id: number;
  dataset_id: number;
  dataset_version_id: number | null;
  split_id?: number | null;
  name: string;
  description: string;
  target_column: string;
  target_columns?: string[];
  problem_type: string;
  algorithm: string;
  hyperparameters: Record<string, unknown>;
  feature_columns: string[];
  ratios?: { train: number; validation: number; test: number };
  random_seed?: number;
  status: string;
  logs: string;
  mlflow_run_id: string | null;
  model_uri: string | null;
  metrics: Record<string, number>;
  error_message: string | null;
  retry_count: number;
  max_retries: number;
  parent_job_id: number | null;
  retrain_source_job_id: number | null;
  is_retrain: boolean;
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
};

export type PipelineGraph = {
  nodes: Array<{
    id: string;
    type?: string;
    position: { x: number; y: number };
    data: Record<string, unknown>;
  }>;
  edges: Array<{
    id?: string;
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
    branch?: "true" | "false" | "always";
    label?: string;
    data?: { branch?: "true" | "false" | "always"; [key: string]: unknown };
  }>;
};

export type Pipeline = {
  id: number;
  project_id: number;
  name: string;
  description: string;
  status: string;
  latest_version: number;
  is_template: boolean;
  version?: { id: number; version: number; graph: PipelineGraph };
  created_at: string;
};

export type PipelineRun = {
  id: number;
  pipeline_id: number;
  pipeline_version_id: number;
  status: string;
  parameters: Record<string, unknown>;
  node_states: Record<string, {
    status: string;
    error?: string;
    reason?: string;
    branch?: "true" | "false";
    label?: string;
    node_type?: string;
    attempt?: number;
    started_at?: string;
    finished_at?: string;
    output?: unknown;
  }>;
  node_artifacts: Record<string, unknown>;
  fail_policy: "stop" | "continue";
  scheduled_for: string | null;
  logs: string;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type ModelVersion = {
  id: number;
  project_id: number;
  name: string;
  version: string;
  lifecycle: string;
  mlflow_run_id: string;
  model_uri: string;
  metrics: Record<string, number>;
  metadata: Record<string, unknown>;
  gates_passed: boolean;
  gate_results: Record<string, unknown>;
  approval_comment: string | null;
  training_job_id: number | null;
  created_at: string;
};

export type Endpoint = {
  id: number;
  project_id: number;
  name: string;
  model_name: string;
  model_version: string;
  model_version_id: number;
  model_uri: string;
  status: string;
  request_count: number;
  success_count: number;
  error_count: number;
  success_rate: number | null;
  average_latency_ms: number | null;
  latency_p95_ms: number;
  feature_schema: Array<string | Record<string, unknown>>;
  prediction_sample?: Record<string, unknown> | null;
  recent_errors: Array<Record<string, unknown>>;
  created_at: string;
};

export type ServiceApiKey = {
  id: number;
  project_id: number;
  endpoint_id: number | null;
  name: string;
  key_prefix: string;
  is_active: boolean;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
};

/** Plaintext `key` is present only in the create response. */
export type CreatedServiceApiKey = ServiceApiKey & {
  key: string;
};

export type ServiceApiKeyCreatePayload = {
  name: string;
  endpoint_id?: number | null;
  expires_at?: string | null;
};

export type BatchJob = {
  id: number;
  dataset_version_id: number;
  endpoint_id: number | null;
  model_version_id: number | null;
  status: string;
  result_format: string;
  row_count: number | null;
  error_message: string | null;
  created_at: string;
};

export type Alert = {
  id: number;
  severity: string;
  title: string;
  message: string;
  is_read: boolean;
  is_resolved: boolean;
  link_path: string | null;
  created_at: string;
};

export type AuditEvent = {
  id: number;
  user_email: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  success: boolean;
  failure_reason: string | null;
  created_at: string;
};

export type AutomationSchedule = {
  id: number;
  project_id: number;
  name: string;
  description: string;
  target_type: "data_import" | "batch_inference" | "pipeline_run";
  target_config: Record<string, unknown>;
  cron_expression: string;
  timezone: string;
  is_enabled: boolean;
  concurrency_policy: "skip" | "queue";
  max_concurrent_runs: number;
  max_retries: number;
  retry_delay_seconds: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
};

export type AutomationScheduleRun = {
  id: number;
  schedule_id: number;
  project_id: number;
  target_type: AutomationSchedule["target_type"];
  scheduled_for: string;
  attempt: number;
  trigger_source: "cron" | "manual";
  status: string;
  target_resource_id: number | null;
  error_message: string | null;
  ready_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};
