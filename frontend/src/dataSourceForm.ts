export const DEFAULT_POSTGRES_PORT = 5432;

export const DEFAULT_POSTGRES_FORM = {
  host: "postgres-source",
  port: String(DEFAULT_POSTGRES_PORT),
  database: "modelflow",
  user: "modelflow",
};

export const DEFAULT_MYSQL_PORT = 3306;

export const DEFAULT_MYSQL_FORM = {
  host: "mysql-source",
  port: String(DEFAULT_MYSQL_PORT),
  database: "modelflow",
  user: "modelflow",
};

export const DEFAULT_MSSQL_PORT = 1433;

export const DEFAULT_MSSQL_FORM = {
  host: "mssql-source",
  port: String(DEFAULT_MSSQL_PORT),
  database: "modelflow",
  user: "modelflow",
};

export const DEFAULT_ORACLE_PORT = 1521;

export const DEFAULT_ORACLE_FORM = {
  host: "oracle-source",
  port: String(DEFAULT_ORACLE_PORT),
  database: "FREEPDB1",
  user: "modelflow",
};

const POSTGRES_FIELD_KEYS = new Set(["host", "port", "database", "user"]);
const ORACLE_FIELD_KEYS = new Set(["host", "port", "service_name", "user"]);
/** Host/Port connection fields cleared when Oracle switches to Connection URL mode. */
const ORACLE_CONNECTION_FIELD_KEYS = new Set([
  "host",
  "port",
  "service_name",
  "user",
  "database",
]);

/** Common Oracle catalog / system schemas — kept visible in discovery; not preferred defaults. */
export const ORACLE_SYSTEM_SCHEMAS = new Set([
  "anonymous",
  "appqossys",
  "audsys",
  "ctxsys",
  "dbsnmp",
  "dip",
  "dvf",
  "dvsys",
  "ggsys",
  "gsmadmin_internal",
  "gsmcatuser",
  "gsmuser",
  "lbacsys",
  "mdsys",
  "ojvmsys",
  "olapsys",
  "oracle_ocm",
  "orddata",
  "ordplugins",
  "ordsys",
  "outln",
  "remote_scheduler_agent",
  "si_informtn_schema",
  "sys",
  "sysbackup",
  "sysdg",
  "syskm",
  "sys$umf",
  "system",
  "wmsys",
  "xdb",
  "xs$null",
]);

export function preferredOracleImportSchema(
  schemas: string[],
  username: string | null | undefined,
): string {
  if (!schemas.length) return "";
  const user = String(username ?? "").trim().toLowerCase();
  const nonSystem = schemas.filter((schema) => !ORACLE_SYSTEM_SCHEMAS.has(schema.toLowerCase()));
  const pool = nonSystem.length > 0 ? nonSystem : schemas;
  if (user) {
    const matched = pool.find((schema) => schema.toLowerCase() === user);
    if (matched) return matched;
  }
  return pool[0] || "";
}

export type PostgresConnectionMode = "host_port" | "connection_url";

export type PostgresConnectionForm = {
  host: string;
  port: string;
  database: string;
  user: string;
};

export type PostgresSavePayload = {
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  clear_secrets?: string[];
};

export type SqlConnectionMode = PostgresConnectionMode;
export type SqlConnectionForm = PostgresConnectionForm;
export type SqlSavePayload = PostgresSavePayload;

export function extraPostgresConfig(config: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!POSTGRES_FIELD_KEYS.has(key) && key.toLowerCase() !== "password") {
      extra[key] = value;
    }
  }
  return extra;
}

export const extraSqlConfig = extraPostgresConfig;

export function postgresFormFromConfig(
  config: Record<string, unknown>,
  defaultPort: number = DEFAULT_POSTGRES_PORT,
): PostgresConnectionForm {
  const portValue = config.port;
  const port =
    typeof portValue === "number" && Number.isFinite(portValue)
      ? String(portValue)
      : typeof portValue === "string" && portValue.trim()
        ? portValue
        : String(defaultPort);
  return {
    host: String(config.host ?? ""),
    port,
    database: String(config.database ?? ""),
    user: String(config.user ?? ""),
  };
}

export function mysqlFormFromConfig(config: Record<string, unknown>): PostgresConnectionForm {
  return postgresFormFromConfig(config, DEFAULT_MYSQL_PORT);
}

export function mssqlFormFromConfig(config: Record<string, unknown>): PostgresConnectionForm {
  return postgresFormFromConfig(config, DEFAULT_MSSQL_PORT);
}

export function oracleFormFromConfig(config: Record<string, unknown>): PostgresConnectionForm {
  const base = postgresFormFromConfig(config, DEFAULT_ORACLE_PORT);
  return {
    ...base,
    database: String(config.service_name ?? config.database ?? ""),
  };
}

export function oracleConfigFromForm(
  form: PostgresConnectionForm,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const cleanedExtra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (!ORACLE_FIELD_KEYS.has(key) && key !== "database") {
      cleanedExtra[key] = value;
    }
  }
  return {
    ...cleanedExtra,
    host: form.host.trim(),
    port: parsePostgresPort(form.port),
    service_name: form.database.trim(),
    user: form.user.trim(),
  };
}

/** Strip Oracle Host/Port connection fields when switching to URL/DSN mode. */
export function oracleExtraConfigForUrlMode(extra: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (!ORACLE_CONNECTION_FIELD_KEYS.has(key)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

export function buildOracleSavePayload(options: {
  mode: PostgresConnectionMode;
  form: PostgresConnectionForm;
  extra: Record<string, unknown>;
  password: string;
  connectionUrl: string;
  editing: boolean;
  previousMode: PostgresConnectionMode | null;
}): PostgresSavePayload {
  const { mode, form, extra, password, connectionUrl, editing, previousMode } = options;
  const trimmedUrl = connectionUrl.trim();

  if (mode === "connection_url") {
    if (!trimmedUrl) {
      if (!editing) {
        throw new Error("Connection URL / DSN is required.");
      }
      if (previousMode === "host_port") {
        throw new Error("Enter a connection URL or DSN when switching connection mode.");
      }
      return {
        config: oracleExtraConfigForUrlMode(extra),
        secrets: {},
      };
    }
    const payload: PostgresSavePayload = {
      config: oracleExtraConfigForUrlMode(extra),
      secrets: { dsn: trimmedUrl },
    };
    if (editing) {
      payload.clear_secrets = ["password", "url"];
    }
    return payload;
  }

  const payload: PostgresSavePayload = {
    config: oracleConfigFromForm(form, extra),
    secrets: postgresSecretsFromPassword(password),
  };
  if (editing) {
    payload.clear_secrets = ["dsn", "url"];
  }
  return payload;
}

export function parsePostgresPort(port: string): number {
  const parsed = Number.parseInt(port, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535 || String(parsed) !== port.trim()) {
    throw new Error("Port must be an integer between 1 and 65535.");
  }
  return parsed;
}

export const parseSqlPort = parsePostgresPort;

export function postgresConfigFromForm(
  form: PostgresConnectionForm,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...extra,
    host: form.host.trim(),
    port: parsePostgresPort(form.port),
    database: form.database.trim(),
    user: form.user.trim(),
  };
}

export const sqlConfigFromForm = postgresConfigFromForm;

export function postgresSecretsFromPassword(password: string): Record<string, string> {
  return password ? { password } : {};
}

export function resolvePostgresConnectionMode(
  connectionMode: PostgresConnectionMode | string | null | undefined,
): PostgresConnectionMode {
  return connectionMode === "connection_url" ? "connection_url" : "host_port";
}

export const resolveSqlConnectionMode = resolvePostgresConnectionMode;

/** Strip host/port/database/user when switching to URL/DSN mode. */
export function postgresExtraConfigForUrlMode(extra: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (!POSTGRES_FIELD_KEYS.has(key)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

export const sqlExtraConfigForUrlMode = postgresExtraConfigForUrlMode;

export function buildPostgresSavePayload(options: {
  mode: PostgresConnectionMode;
  form: PostgresConnectionForm;
  extra: Record<string, unknown>;
  password: string;
  connectionUrl: string;
  editing: boolean;
  previousMode: PostgresConnectionMode | null;
}): PostgresSavePayload {
  const { mode, form, extra, password, connectionUrl, editing, previousMode } = options;
  const trimmedUrl = connectionUrl.trim();

  if (mode === "connection_url") {
    if (!trimmedUrl) {
      if (!editing) {
        throw new Error("Connection URL / DSN is required.");
      }
      if (previousMode === "host_port") {
        throw new Error("Enter a connection URL or DSN when switching connection mode.");
      }
      // Blank URL while already in connection_url mode keeps the saved DSN/URL.
      return {
        config: postgresExtraConfigForUrlMode(extra),
        secrets: {},
      };
    }
    const payload: PostgresSavePayload = {
      config: postgresExtraConfigForUrlMode(extra),
      secrets: { dsn: trimmedUrl },
    };
    if (editing) {
      // Prefer `dsn` as the stored key; drop password/url so they cannot stale-override.
      payload.clear_secrets = ["password", "url"];
    }
    return payload;
  }

  const payload: PostgresSavePayload = {
    config: postgresConfigFromForm(form, extra),
    secrets: postgresSecretsFromPassword(password),
  };
  if (editing) {
    // Typed host/port must win over any leftover DSN/URL secrets.
    payload.clear_secrets = ["dsn", "url"];
  }
  return payload;
}

/** Host/Port + Connection URL payload builder shared by PostgreSQL and MySQL. */
export const buildSqlSavePayload = buildPostgresSavePayload;


export type RestApiAuthType = "none" | "bearer" | "api_key";

export type RestApiConnectionForm = {
  baseUrl: string;
  resourcePath: string;
  dataPath: string;
  timeoutSeconds: string;
  authType: RestApiAuthType;
  apiKeyHeader: string;
  queryParams: string;
};

export type RestApiSavePayload = {
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  clear_secrets?: string[];
};

export const DEFAULT_REST_API_FORM: RestApiConnectionForm = {
  baseUrl: "",
  resourcePath: "",
  dataPath: "",
  timeoutSeconds: "10",
  authType: "none",
  apiKeyHeader: "X-API-Key",
  queryParams: "{}",
};

export function restApiFormFromConfig(
  config: Record<string, unknown>,
): RestApiConnectionForm {
  const queryParams =
    config.query_params && typeof config.query_params === "object"
      ? JSON.stringify(config.query_params, null, 2)
      : "{}";
  const authType =
    config.auth_type === "bearer" || config.auth_type === "api_key"
      ? config.auth_type
      : "none";
  return {
    baseUrl: String(config.base_url ?? ""),
    resourcePath: String(config.resource_path ?? ""),
    dataPath: String(config.data_path ?? ""),
    timeoutSeconds: String(config.timeout_seconds ?? 10),
    authType,
    apiKeyHeader: String(config.api_key_header ?? "X-API-Key"),
    queryParams,
  };
}

function parseRestApiBaseUrl(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Base URL must be a valid absolute http(s) URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.host) {
    throw new Error("Base URL must be a valid absolute http(s) URL.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Do not put credentials in the Base URL. Use Authentication fields.");
  }
  return trimmed.replace(/\/+$/, "");
}

function parseRestApiTimeout(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 60) {
    throw new Error("Timeout must be between 1 and 60 seconds.");
  }
  return parsed;
}

function parseRestApiQueryParams(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Query parameters must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function buildRestApiSavePayload(options: {
  form: RestApiConnectionForm;
  bearerToken: string;
  apiKey: string;
  editing: boolean;
  previousAuthType: RestApiAuthType | null;
  hasSecrets: boolean;
}): RestApiSavePayload {
  const { form, bearerToken, apiKey, editing, previousAuthType, hasSecrets } = options;
  const baseUrl = parseRestApiBaseUrl(form.baseUrl);
  const queryParams = parseRestApiQueryParams(form.queryParams);
  const resourcePath = form.resourcePath.trim();
  const dataPath = form.dataPath.trim();
  const apiKeyHeader = form.apiKeyHeader.trim();

  if (resourcePath && /^https?:\/\//i.test(resourcePath)) {
    throw new Error("Resource path must be relative to the Base URL.");
  }
  if (form.authType === "api_key" && !apiKeyHeader) {
    throw new Error("API key header is required.");
  }

  const config: Record<string, unknown> = {
    base_url: baseUrl,
    resource_path: resourcePath,
    auth_type: form.authType,
    timeout_seconds: parseRestApiTimeout(form.timeoutSeconds),
  };
  if (dataPath) config.data_path = dataPath;
  if (Object.keys(queryParams).length > 0) config.query_params = queryParams;
  if (form.authType === "api_key") config.api_key_header = apiKeyHeader;

  const secrets: Record<string, string> = {};
  const clear: string[] = [];

  if (form.authType === "none") {
    if (editing) clear.push("bearer_token", "token", "api_key");
  } else if (form.authType === "bearer") {
    const token = bearerToken.trim();
    const canKeepExisting =
      editing && previousAuthType === "bearer" && hasSecrets && !token;
    if (!token && !canKeepExisting) {
      throw new Error("Bearer token is required.");
    }
    if (token) secrets.bearer_token = token;
    if (editing) clear.push("api_key", "token");
  } else {
    const key = apiKey.trim();
    const canKeepExisting =
      editing && previousAuthType === "api_key" && hasSecrets && !key;
    if (!key && !canKeepExisting) {
      throw new Error("API key is required.");
    }
    if (key) secrets.api_key = key;
    if (editing) clear.push("bearer_token", "token");
  }

  return {
    config,
    secrets,
    ...(clear.length > 0 ? { clear_secrets: clear } : {}),
  };
}
