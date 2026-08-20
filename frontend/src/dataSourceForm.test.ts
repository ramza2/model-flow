import { describe, expect, it } from "vitest";
import {
  DEFAULT_POSTGRES_PORT,
  extraPostgresConfig,
  postgresConfigFromForm,
  postgresFormFromConfig,
  postgresSecretsFromPassword,
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
});
