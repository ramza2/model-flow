import { describe, expect, it } from "vitest";
import {
  DEFAULT_POSTGRES_PORT,
  buildPostgresSavePayload,
  extraPostgresConfig,
  parsePostgresPort,
  postgresConfigFromForm,
  postgresFormFromConfig,
  postgresSecretsFromPassword,
  resolvePostgresConnectionMode,
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
