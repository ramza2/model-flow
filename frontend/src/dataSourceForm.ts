export const DEFAULT_POSTGRES_PORT = 5432;

export const DEFAULT_POSTGRES_FORM = {
  host: "postgres-source",
  port: String(DEFAULT_POSTGRES_PORT),
  database: "modelflow",
  user: "modelflow",
};

const POSTGRES_FIELD_KEYS = new Set(["host", "port", "database", "user"]);

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

export function extraPostgresConfig(config: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!POSTGRES_FIELD_KEYS.has(key) && key.toLowerCase() !== "password") {
      extra[key] = value;
    }
  }
  return extra;
}

export function postgresFormFromConfig(config: Record<string, unknown>): PostgresConnectionForm {
  const portValue = config.port;
  const port =
    typeof portValue === "number" && Number.isFinite(portValue)
      ? String(portValue)
      : typeof portValue === "string" && portValue.trim()
        ? portValue
        : String(DEFAULT_POSTGRES_PORT);
  return {
    host: String(config.host ?? ""),
    port,
    database: String(config.database ?? ""),
    user: String(config.user ?? ""),
  };
}

export function parsePostgresPort(port: string): number {
  const parsed = Number.parseInt(port, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535 || String(parsed) !== port.trim()) {
    throw new Error("Port must be an integer between 1 and 65535.");
  }
  return parsed;
}

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

export function postgresSecretsFromPassword(password: string): Record<string, string> {
  return password ? { password } : {};
}

export function resolvePostgresConnectionMode(
  connectionMode: PostgresConnectionMode | string | null | undefined,
): PostgresConnectionMode {
  return connectionMode === "connection_url" ? "connection_url" : "host_port";
}

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
