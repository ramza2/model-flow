import { describe, expect, it } from "vitest";
import {
  DEFAULT_MYSQL_FORM,
  DEFAULT_MYSQL_PORT,
  DEFAULT_MSSQL_FORM,
  DEFAULT_MSSQL_PORT,
  DEFAULT_ORACLE_FORM,
  DEFAULT_ORACLE_PORT,
  DEFAULT_POSTGRES_FORM,
  DEFAULT_POSTGRES_PORT,
  DEFAULT_REST_API_FORM,
  buildOracleSavePayload,
  buildPostgresSavePayload,
  buildRestApiSavePayload,
  buildSqlSavePayload,
  extraPostgresConfig,
  mssqlFormFromConfig,
  mysqlFormFromConfig,
  oracleConfigFromForm,
  oracleFormFromConfig,
  parsePostgresPort,
  preferredOracleImportSchema,
  postgresConfigFromForm,
  postgresFormFromConfig,
  postgresSecretsFromPassword,
  resolvePostgresConnectionMode,
  restApiFormFromConfig,
} from "./dataSourceForm";

describe("postgres data source form helpers", () => {
  it("builds the existing API configuration payload from typed fields", () => {
    expect(
      postgresConfigFromForm({
        host: "postgres-source",
        port: "5432",
        database: "source",
        user: "source",
      }),
    ).toEqual({
      host: "postgres-source",
      port: DEFAULT_POSTGRES_PORT,
      database: "source",
      user: "source",
    });
  });

  it("preserves extra non-secret config keys on save", () => {
    expect(
      postgresConfigFromForm(
        { host: "db.internal", port: "5433", database: "analytics", user: "reader" },
        { sslmode: "require" },
      ),
    ).toEqual({
      sslmode: "require",
      host: "db.internal",
      port: 5433,
      database: "analytics",
      user: "reader",
    });
  });

  it("loads saved non-secret values into the form", () => {
    expect(
      postgresFormFromConfig({
        host: "postgres-source",
        port: 5432,
        database: "db",
        user: "u",
        sslmode: "require",
      }),
    ).toEqual({
      host: "postgres-source",
      port: "5432",
      database: "db",
      user: "u",
    });
    expect(
      extraPostgresConfig({
        host: "postgres-source",
        port: 5432,
        database: "db",
        user: "u",
        sslmode: "require",
      }),
    ).toEqual({ sslmode: "require" });
  });

  it("sends no password secret when the field is blank", () => {
    expect(postgresSecretsFromPassword("")).toEqual({});
    expect(postgresSecretsFromPassword("secret")).toEqual({ password: "secret" });
  });

  it("rejects malformed or out-of-range ports", () => {
    expect(() => parsePostgresPort("70000")).toThrow(/1 and 65535/i);
    expect(() => parsePostgresPort("5432abc")).toThrow(/1 and 65535/i);
    expect(() => parsePostgresPort("0")).toThrow(/1 and 65535/i);
    expect(parsePostgresPort("5432")).toBe(5432);
  });

  it("builds MySQL host/port payloads with default port 3306 and no password in config", () => {
    expect(DEFAULT_MYSQL_FORM.port).toBe(String(DEFAULT_MYSQL_PORT));
    expect(DEFAULT_MYSQL_PORT).toBe(3306);
    expect(mysqlFormFromConfig({})).toEqual({
      host: "",
      port: "3306",
      database: "",
      user: "",
    });
    const created = buildSqlSavePayload({
      mode: "host_port",
      form: {
        host: "mysql-source",
        port: "3306",
        database: "analytics",
        user: "reader",
      },
      extra: {},
      password: "secret",
      connectionUrl: "",
      editing: false,
      previousMode: null,
    });
    expect(created.config).toEqual({
      host: "mysql-source",
      port: 3306,
      database: "analytics",
      user: "reader",
    });
    expect(created.secrets).toEqual({ password: "secret" });
    expect(JSON.stringify(created.config)).not.toContain("secret");

    const blankEdit = buildSqlSavePayload({
      mode: "host_port",
      form: DEFAULT_MYSQL_FORM,
      extra: {},
      password: "",
      connectionUrl: "",
      editing: true,
      previousMode: "host_port",
    });
    expect(blankEdit.secrets).toEqual({});
    expect(blankEdit.clear_secrets).toEqual(["dsn", "url"]);
  });

  it("builds Microsoft SQL Server host/port payloads with default port 1433", () => {
    expect(DEFAULT_MSSQL_FORM.port).toBe(String(DEFAULT_MSSQL_PORT));
    expect(DEFAULT_MSSQL_PORT).toBe(1433);
    expect(mssqlFormFromConfig({})).toEqual({
      host: "",
      port: "1433",
      database: "",
      user: "",
    });
    const created = buildSqlSavePayload({
      mode: "host_port",
      form: {
        host: "mssql-source",
        port: "1433",
        database: "analytics",
        user: "reader",
      },
      extra: { trust_server_certificate: true },
      password: "secret",
      connectionUrl: "",
      editing: false,
      previousMode: null,
    });
    expect(created.config).toEqual({
      trust_server_certificate: true,
      host: "mssql-source",
      port: 1433,
      database: "analytics",
      user: "reader",
    });
    expect(created.secrets).toEqual({ password: "secret" });
    expect(JSON.stringify(created.config)).not.toContain("secret");
  });

  it("builds Oracle host/port payloads with service_name and default port 1521", () => {
    expect(DEFAULT_ORACLE_FORM.port).toBe(String(DEFAULT_ORACLE_PORT));
    expect(DEFAULT_ORACLE_PORT).toBe(1521);
    expect(oracleFormFromConfig({ service_name: "FREEPDB1" })).toEqual({
      host: "",
      port: "1521",
      database: "FREEPDB1",
      user: "",
    });
    expect(
      oracleConfigFromForm({
        host: "oracle-source",
        port: "1521",
        database: "FREEPDB1",
        user: "reader",
      }),
    ).toEqual({
      host: "oracle-source",
      port: 1521,
      service_name: "FREEPDB1",
      user: "reader",
    });
    const created = buildOracleSavePayload({
      mode: "host_port",
      form: {
        host: "oracle-source",
        port: "1521",
        database: "FREEPDB1",
        user: "reader",
      },
      extra: {},
      password: "secret",
      connectionUrl: "",
      editing: false,
      previousMode: null,
    });
    expect(created.config).toEqual({
      host: "oracle-source",
      port: 1521,
      service_name: "FREEPDB1",
      user: "reader",
    });
    expect(created.secrets).toEqual({ password: "secret" });
    expect(JSON.stringify(created.config)).not.toContain("secret");
  });

  it("clears Oracle Host/Port fields when switching to Connection URL mode", () => {
    const switched = buildOracleSavePayload({
      mode: "connection_url",
      form: {
        host: "oracle-source",
        port: "1521",
        database: "FREEPDB1",
        user: "reader",
      },
      extra: {
        host: "oracle-source",
        port: 1521,
        service_name: "FREEPDB1",
        user: "reader",
        database: "legacy",
        note: "keep-me",
      },
      password: "",
      connectionUrl: "oracle://reader:x@oracle-source:1521/?service_name=OTHER",
      editing: true,
      previousMode: "host_port",
    });
    expect(switched.config).toEqual({ note: "keep-me" });
    expect(switched.secrets).toEqual({
      dsn: "oracle://reader:x@oracle-source:1521/?service_name=OTHER",
    });
    expect(switched.clear_secrets).toEqual(["password", "url"]);
    for (const stale of ["host", "port", "service_name", "user", "database"]) {
      expect(switched.config).not.toHaveProperty(stale);
    }
  });

  it("prefers Oracle username / non-system schemas for import defaults", () => {
    const schemas = ["SYS", "SYSTEM", "oraapp_demo", "oraro_reader"];
    expect(preferredOracleImportSchema(schemas, "ORAAPP_DEMO")).toBe("oraapp_demo");
    expect(preferredOracleImportSchema(schemas, "missing")).toBe("oraapp_demo");
    expect(preferredOracleImportSchema(["SYS", "SYSTEM"], "x")).toBe("SYS");
  });

  it("resolves connection mode metadata without exposing secrets", () => {
    expect(resolvePostgresConnectionMode("connection_url")).toBe("connection_url");
    expect(resolvePostgresConnectionMode("host_port")).toBe("host_port");
    expect(resolvePostgresConnectionMode(null)).toBe("host_port");
  });

  it("loads DSN/URL sources into connection_url edit mode without a URL value", () => {
    const form = postgresFormFromConfig({});
    expect(form.host).toBe("");
    expect(form.database).toBe("");
    expect(form.user).toBe("");
    const payload = buildPostgresSavePayload({
      mode: "connection_url",
      form,
      extra: {},
      password: "",
      connectionUrl: "",
      editing: true,
      previousMode: "connection_url",
    });
    expect(payload.secrets).toEqual({});
    expect(payload.clear_secrets).toBeUndefined();
    expect(JSON.stringify(payload)).not.toMatch(/postgresql:\/\//i);
  });

  it("keeps the saved DSN/URL when the connection URL field is blank on edit", () => {
    expect(
      buildPostgresSavePayload({
        mode: "connection_url",
        form: DEFAULT_POSTGRES_FORM,
        extra: { sslmode: "require" },
        password: "",
        connectionUrl: "   ",
        editing: true,
        previousMode: "connection_url",
      }),
    ).toEqual({
      config: { sslmode: "require" },
      secrets: {},
    });
  });

  it("name-only DSN edit keeps secrets empty so the backend retains the connection URL", () => {
    const payload = buildPostgresSavePayload({
      mode: "connection_url",
      form: { host: "", port: "5432", database: "", user: "" },
      extra: {},
      password: "",
      connectionUrl: "",
      editing: true,
      previousMode: "connection_url",
    });
    expect(payload).toEqual({ config: {}, secrets: {} });
  });

  it("clears DSN/URL secrets when switching to typed host/port mode", () => {
    const payload = buildPostgresSavePayload({
      mode: "host_port",
      form: { host: "db.internal", port: "5432", database: "analytics", user: "reader" },
      extra: {},
      password: "new-pass",
      connectionUrl: "",
      editing: true,
      previousMode: "connection_url",
    });
    expect(payload.config).toEqual({
      host: "db.internal",
      port: 5432,
      database: "analytics",
      user: "reader",
    });
    expect(payload.secrets).toEqual({ password: "new-pass" });
    expect(payload.clear_secrets).toEqual(["dsn", "url"]);
  });

  it("stores a new DSN when switching from typed mode to connection URL mode", () => {
    const payload = buildPostgresSavePayload({
      mode: "connection_url",
      form: DEFAULT_POSTGRES_FORM,
      extra: { host: "stale", port: 5432, database: "stale", user: "stale" },
      password: "",
      connectionUrl: "postgresql://reader@db.internal:5432/analytics",
      editing: true,
      previousMode: "host_port",
    });
    expect(payload.config).toEqual({});
    expect(payload.secrets).toEqual({ dsn: "postgresql://reader@db.internal:5432/analytics" });
    expect(payload.clear_secrets).toEqual(["password", "url"]);
  });

  it("requires a connection URL when creating or switching into URL mode", () => {
    expect(() =>
      buildPostgresSavePayload({
        mode: "connection_url",
        form: DEFAULT_POSTGRES_FORM,
        extra: {},
        password: "",
        connectionUrl: "",
        editing: false,
        previousMode: null,
      }),
    ).toThrow(/Connection URL/i);
    expect(() =>
      buildPostgresSavePayload({
        mode: "connection_url",
        form: DEFAULT_POSTGRES_FORM,
        extra: {},
        password: "",
        connectionUrl: "",
        editing: true,
        previousMode: "host_port",
      }),
    ).toThrow(/switching connection mode/i);
  });
});


describe("REST API data source form helpers", () => {
  it("builds public config separately from bearer credentials", () => {
    const payload = buildRestApiSavePayload({
      form: {
        ...DEFAULT_REST_API_FORM,
        baseUrl: "https://api.example.com/v1/",
        resourcePath: "/customers",
        dataPath: "data.items",
        timeoutSeconds: "15",
        authType: "bearer",
        queryParams: '{"limit":100}',
      },
      bearerToken: "secret-token",
      apiKey: "",
      editing: false,
      previousAuthType: null,
      hasSecrets: false,
    });
    expect(payload.config).toEqual({
      base_url: "https://api.example.com/v1",
      resource_path: "/customers",
      data_path: "data.items",
      auth_type: "bearer",
      timeout_seconds: 15,
      query_params: { limit: 100 },
    });
    expect(payload.secrets).toEqual({ bearer_token: "secret-token" });
    expect(JSON.stringify(payload.config)).not.toContain("secret-token");
  });

  it("keeps an existing bearer token on edit when the secret field is blank", () => {
    const payload = buildRestApiSavePayload({
      form: {
        ...restApiFormFromConfig({
          base_url: "https://api.example.com",
          resource_path: "/customers",
          auth_type: "bearer",
        }),
      },
      bearerToken: "",
      apiKey: "",
      editing: true,
      previousAuthType: "bearer",
      hasSecrets: true,
    });
    expect(payload.secrets).toEqual({});
    expect(payload.clear_secrets).toEqual(["api_key", "token"]);
  });

  it("requires a new credential when switching REST authentication mode", () => {
    expect(() =>
      buildRestApiSavePayload({
        form: {
          ...DEFAULT_REST_API_FORM,
          baseUrl: "https://api.example.com",
          authType: "api_key",
        },
        bearerToken: "",
        apiKey: "",
        editing: true,
        previousAuthType: "bearer",
        hasSecrets: true,
      }),
    ).toThrow(/API key is required/i);
  });

  it("clears saved auth secrets when switching to unauthenticated REST", () => {
    const payload = buildRestApiSavePayload({
      form: {
        ...DEFAULT_REST_API_FORM,
        baseUrl: "https://api.example.com",
        authType: "none",
      },
      bearerToken: "",
      apiKey: "",
      editing: true,
      previousAuthType: "bearer",
      hasSecrets: true,
    });
    expect(payload.clear_secrets).toEqual(["bearer_token", "token", "api_key"]);
  });

  it("rejects credentials embedded in a REST base URL and absolute resource paths", () => {
    expect(() =>
      buildRestApiSavePayload({
        form: {
          ...DEFAULT_REST_API_FORM,
          baseUrl: "https://user:pass@example.com",
        },
        bearerToken: "",
        apiKey: "",
        editing: false,
        previousAuthType: null,
        hasSecrets: false,
      }),
    ).toThrow(/credentials/i);

    expect(() =>
      buildRestApiSavePayload({
        form: {
          ...DEFAULT_REST_API_FORM,
          baseUrl: "https://api.example.com",
          resourcePath: "https://other.example.com/data",
        },
        bearerToken: "",
        apiKey: "",
        editing: false,
        previousAuthType: null,
        hasSecrets: false,
      }),
    ).toThrow(/relative/i);
  });
});
