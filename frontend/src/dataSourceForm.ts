export const DEFAULT_POSTGRES_PORT = 5432;

export const DEFAULT_POSTGRES_FORM = {
  host: "postgres-source",
  port: String(DEFAULT_POSTGRES_PORT),
  database: "modelflow",
  user: "modelflow",
};

const POSTGRES_FIELD_KEYS = new Set(["host", "port", "database", "user"]);

export type PostgresConnectionForm = {
  host: string;
  port: string;
  database: string;
  user: string;
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

export function postgresConfigFromForm(
  form: PostgresConnectionForm,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const parsed = Number.parseInt(form.port, 10);
  const port = Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_POSTGRES_PORT;
  return {
    ...extra,
    host: form.host.trim(),
    port,
    database: form.database.trim(),
    user: form.user.trim(),
  };
}

export function postgresSecretsFromPassword(password: string): Record<string, string> {
  return password ? { password } : {};
}
