import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  api,
  jsonBody,
  type CreatedServiceApiKey,
  type Endpoint,
  type ServiceApiKey,
} from "../api";
import { useAuth } from "../AuthContext";
import {
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
  SuccessNotice,
  confirmAction,
  formatDate,
} from "../components";
import {
  CURL_KEY_PLACEHOLDER,
  buildExternalPredictCurl,
  copyToClipboard,
  datetimeLocalToIsoUtc,
  externalPredictUrl,
  formatExternalPredictRequestJson,
  keysForDeployment,
  parseFeatureSchemaFields,
  serviceKeyScopeLabel,
  serviceKeyStatus,
} from "../deploymentApiUsage";
import { userCanProject, useProject } from "../ProjectContext";

type CopyTarget = "url" | "json" | "curl" | "key" | null;

type CreateScope = "deployment" | "project";
type ExpirationMode = "none" | "custom";

export default function DeploymentApiUsage() {
  const { projectId, endpointId } = useParams();
  const numericEndpointId = Number(endpointId);
  const numericProjectId = Number(projectId);
  const { user } = useAuth();
  const { selectedProject } = useProject();

  const [endpoint, setEndpoint] = useState<Endpoint | null>(null);
  const [keys, setKeys] = useState<ServiceApiKey[]>([]);
  const [loadingEndpoint, setLoadingEndpoint] = useState(true);
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [copied, setCopied] = useState<CopyTarget>(null);
  const [busy, setBusy] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [keyScope, setKeyScope] = useState<CreateScope>("deployment");
  const [expirationMode, setExpirationMode] = useState<ExpirationMode>("none");
  const [expirationLocal, setExpirationLocal] = useState("");

  const [createdKeyPlaintext, setCreatedKeyPlaintext] = useState<string | null>(null);
  const [createdKeyPrefix, setCreatedKeyPrefix] = useState<string | null>(null);

  const canManageKeys = userCanProject(user, selectedProject, "ML_ENGINEER", "PROJECT_ADMIN");

  const refreshKeys = useCallback(async () => {
    if (!canManageKeys || !numericProjectId) return;
    setLoadingKeys(true);
    try {
      const rows = await api<ServiceApiKey[]>(`/projects/${numericProjectId}/service-api-keys`);
      setKeys(keysForDeployment(rows, numericEndpointId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Service API keys could not be loaded.");
    } finally {
      setLoadingKeys(false);
    }
  }, [canManageKeys, numericEndpointId, numericProjectId]);

  useEffect(() => {
    let cancelled = false;
    setLoadingEndpoint(true);
    setError("");
    api<Endpoint>(`/endpoints/${endpointId}`)
      .then((row) => {
        if (!cancelled) setEndpoint(row);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Deployment could not be loaded.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingEndpoint(false);
      });
    return () => {
      cancelled = true;
    };
  }, [endpointId]);

  useEffect(() => {
    if (canManageKeys) void refreshKeys();
  }, [canManageKeys, refreshKeys]);

  const schemaFields = useMemo(
    () => parseFeatureSchemaFields(endpoint?.feature_schema || []),
    [endpoint?.feature_schema],
  );

  const requestJson = useMemo(
    () => (endpoint ? formatExternalPredictRequestJson(endpoint) : ""),
    [endpoint],
  );

  const curlExample = useMemo(
    () => (endpoint ? buildExternalPredictCurl(endpoint) : ""),
    [endpoint],
  );

  const predictUrl = endpoint ? externalPredictUrl(endpoint.id) : "";

  async function onCopy(target: CopyTarget, text: string) {
    setError("");
    try {
      await copyToClipboard(text);
      setCopied(target);
      window.setTimeout(() => setCopied((current) => (current === target ? null : current)), 2000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Copy failed.");
    }
  }

  async function onCreateKey(e: FormEvent) {
    e.preventDefault();
    if (!endpoint) return;
    setError("");
    setSuccess("");
    setBusy("create-key");
    try {
      let expiresAt: string | null = null;
      if (expirationMode === "custom") {
        expiresAt = datetimeLocalToIsoUtc(expirationLocal);
      }
      const created = await api<CreatedServiceApiKey>(
        `/projects/${numericProjectId}/service-api-keys`,
        {
          method: "POST",
          ...jsonBody({
            name: keyName.trim(),
            endpoint_id: keyScope === "deployment" ? endpoint.id : null,
            expires_at: expiresAt,
          }),
        },
      );
      setCreatedKeyPlaintext(created.key);
      setCreatedKeyPrefix(created.key_prefix);
      setShowCreate(false);
      setKeyName("");
      setKeyScope("deployment");
      setExpirationMode("none");
      setExpirationLocal("");
      setSuccess("Service API key created.");
      await refreshKeys();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Service API key could not be created.");
    } finally {
      setBusy("");
    }
  }

  function dismissCreatedKey() {
    setCreatedKeyPlaintext(null);
    setCreatedKeyPrefix(null);
  }

  async function onRevokeKey(key: ServiceApiKey) {
    if (
      !confirmAction(
        `Revoke service key “${key.name}”?\n\nApplications using this key will immediately lose access.\nThis action cannot be undone.`,
      )
    ) {
      return;
    }
    setError("");
    setSuccess("");
    setBusy(`revoke-${key.id}`);
    try {
      await api(`/projects/${numericProjectId}/service-api-keys/${key.id}/revoke`, {
        method: "POST",
      });
      setSuccess(`Service key “${key.name}” revoked.`);
      await refreshKeys();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Service API key could not be revoked.");
    } finally {
      setBusy("");
    }
  }

  const copyLabel = (target: CopyTarget, label: string) =>
    copied === target ? "Copied" : label;

  return (
    <div className="api-usage-page">
      <PageHeader
        title="API usage"
        description={
          endpoint
            ? `Call ${endpoint.name} from an external application.`
            : "External inference integration for this deployment."
        }
        actions={endpoint ? <StatusBadge status={endpoint.status} /> : undefined}
      />
      <ErrorNotice message={error} />
      <SuccessNotice message={success} />

      {loadingEndpoint ? (
        <Loading label="Loading deployment" />
      ) : !endpoint ? (
        <div className="notice">Deployment details are unavailable.</div>
      ) : (
        <>
          <section className="panel api-usage-header">
            <div className="panel-title">
              <div>
                <span className="eyebrow">Deployment</span>
                <h2>{endpoint.name}</h2>
              </div>
              <StatusBadge status={endpoint.status} />
            </div>
            <p className="mono">
              {endpoint.model_name} · v{endpoint.model_version}
            </p>
            {endpoint.status === "stopped" && (
              <div className="notice" data-testid="api-usage-stopped-notice">
                This deployment is stopped. External prediction requests will return 409 until it
                is started.
              </div>
            )}
          </section>

          <section className="panel api-usage-block" data-testid="api-usage-endpoint">
            <div className="panel-title">
              <div>
                <span className="eyebrow">Endpoint</span>
                <h2>HTTP method &amp; URL</h2>
              </div>
              <button
                type="button"
                className="btn secondary"
                data-testid="copy-url"
                onClick={() => void onCopy("url", predictUrl)}
              >
                {copyLabel("url", "Copy URL")}
              </button>
            </div>
            <dl className="api-meta">
              <div>
                <dt>Method</dt>
                <dd>
                  <span className="method-pill" data-testid="api-usage-method">
                    POST
                  </span>
                </dd>
              </div>
              <div>
                <dt>Endpoint</dt>
                <dd className="mono" data-testid="api-usage-url">
                  {predictUrl}
                </dd>
              </div>
            </dl>
          </section>

          <section className="panel api-usage-block" data-testid="api-usage-auth">
            <div className="panel-title">
              <div>
                <span className="eyebrow">Security</span>
                <h2>Authentication</h2>
              </div>
            </div>
            <p>
              <strong>Bearer Service API Key</strong>
            </p>
            <pre className="json-view mono">Authorization: Bearer &lt;SERVICE_API_KEY&gt;</pre>
            <p className="muted-copy">
              Service API Keys are intended for external applications. ModelFlow user access tokens
              cannot be used with this endpoint.
            </p>
          </section>

          <div className="api-usage-grid">
            <section className="panel api-usage-block" data-testid="api-usage-schema">
              <div className="panel-title">
                <div>
                  <span className="eyebrow">Schema</span>
                  <h2>Request schema</h2>
                </div>
              </div>
              {schemaFields.length === 0 ? (
                <p className="muted-copy">
                  No feature schema is available for this deployment. Use the sample request as a
                  reference.
                </p>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Field</th>
                        <th>Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {schemaFields.map((field) => (
                        <tr key={field.name}>
                          <td className="mono">{field.name}</td>
                          <td>{field.type}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="panel api-usage-block" data-testid="api-usage-sample">
              <div className="panel-title">
                <div>
                  <span className="eyebrow">Body</span>
                  <h2>Sample request</h2>
                </div>
                <button
                  type="button"
                  className="btn secondary"
                  data-testid="copy-json"
                  onClick={() => void onCopy("json", requestJson)}
                >
                  {copyLabel("json", "Copy JSON")}
                </button>
              </div>
              <pre className="json-view" data-testid="api-usage-sample-json">
                {requestJson}
              </pre>
            </section>
          </div>

          <section className="panel api-usage-block" data-testid="api-usage-curl">
            <div className="panel-title">
              <div>
                <span className="eyebrow">Example</span>
                <h2>cURL</h2>
              </div>
              <button
                type="button"
                className="btn secondary"
                data-testid="copy-curl"
                onClick={() => void onCopy("curl", curlExample)}
              >
                {copyLabel("curl", "Copy cURL")}
              </button>
            </div>
            <pre className="json-view mono" data-testid="api-usage-curl-text">
              {curlExample}
            </pre>
            <p className="muted-copy">
              Replace <code>{CURL_KEY_PLACEHOLDER}</code> with a Service API Key from the section
              below.
            </p>
          </section>

          <section className="panel api-usage-block" data-testid="api-usage-keys">
            <div className="panel-title">
              <div>
                <span className="eyebrow">Credentials</span>
                <h2>Service API Keys</h2>
              </div>
              {canManageKeys && (
                <button
                  type="button"
                  className="btn"
                  data-testid="create-service-key"
                  onClick={() => setShowCreate((open) => !open)}
                >
                  Create service key
                </button>
              )}
            </div>

            {canManageKeys && (
              <p className="muted-copy" data-testid="api-usage-keys-revoke-help">
                Revoking a key immediately blocks applications using it. Revoked keys cannot be
                reactivated.
              </p>
            )}

            {!canManageKeys && (
              <p className="muted-copy" data-testid="api-usage-keys-permission">
                A Project Admin or ML Engineer can create a Service API Key for this deployment.
              </p>
            )}

            {canManageKeys && showCreate && (
              <form className="form api-key-create-form" onSubmit={onCreateKey}>
                <label>
                  Name
                  <input
                    value={keyName}
                    onChange={(event) => setKeyName(event.target.value)}
                    required
                    data-testid="service-key-name"
                  />
                </label>
                <fieldset className="radio-fieldset">
                  <legend>Scope</legend>
                  <label>
                    <input
                      type="radio"
                      name="key-scope"
                      checked={keyScope === "deployment"}
                      onChange={() => setKeyScope("deployment")}
                    />
                    This deployment
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="key-scope"
                      checked={keyScope === "project"}
                      onChange={() => setKeyScope("project")}
                    />
                    All deployments in this project
                  </label>
                  {keyScope === "project" && (
                    <p className="muted-copy">
                      Project-scoped keys can call every deployment in this project.
                    </p>
                  )}
                </fieldset>
                <fieldset className="radio-fieldset">
                  <legend>Expiration</legend>
                  <label>
                    <input
                      type="radio"
                      name="key-expiration"
                      checked={expirationMode === "none"}
                      onChange={() => setExpirationMode("none")}
                    />
                    No expiration
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="key-expiration"
                      checked={expirationMode === "custom"}
                      onChange={() => setExpirationMode("custom")}
                    />
                    Custom expiration
                  </label>
                  {expirationMode === "custom" && (
                    <label>
                      Expires at (local time)
                      <input
                        type="datetime-local"
                        value={expirationLocal}
                        onChange={(event) => setExpirationLocal(event.target.value)}
                        required
                        data-testid="service-key-expiration"
                      />
                    </label>
                  )}
                </fieldset>
                <div className="row-actions">
                  <button
                    className="btn"
                    type="submit"
                    disabled={busy === "create-key" || !keyName.trim()}
                    data-testid="service-key-submit"
                  >
                    {busy === "create-key" ? "Creating…" : "Create key"}
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => setShowCreate(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {createdKeyPlaintext && (
              <div className="panel secret-once-panel" data-testid="service-key-once-panel">
                <div className="panel-title">
                  <div>
                    <span className="eyebrow">One-time secret</span>
                    <h2>Service API Key created</h2>
                  </div>
                </div>
                <p>This key is shown only once. Copy it now and store it securely.</p>
                {createdKeyPrefix && (
                  <p className="mono muted-copy">Prefix: {createdKeyPrefix}</p>
                )}
                <pre className="json-view mono" data-testid="service-key-plaintext">
                  {createdKeyPlaintext}
                </pre>
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn"
                    data-testid="copy-service-key"
                    onClick={() => void onCopy("key", createdKeyPlaintext)}
                  >
                    {copyLabel("key", "Copy key")}
                  </button>
                  <button
                    type="button"
                    className="btn secondary"
                    data-testid="service-key-done"
                    onClick={dismissCreatedKey}
                  >
                    Done
                  </button>
                </div>
              </div>
            )}

            {canManageKeys && loadingKeys ? (
              <Loading label="Loading service keys" />
            ) : canManageKeys && keys.length === 0 ? (
              <div className="empty-inline" data-testid="service-key-empty">
                <p>
                  <strong>No service API keys</strong>
                </p>
                <p>Create a key to call this deployment from an external application.</p>
              </div>
            ) : (
              canManageKeys && (
                <div className="service-key-list">
                  {keys.map((key) => {
                    const status = serviceKeyStatus(key);
                    return (
                      <article className="service-key-card" key={key.id} data-testid="service-key-row">
                        <header>
                          <h3>{key.name}</h3>
                          <span className={`badge ${status === "Active" ? "ok" : "warn"}`}>
                            {status}
                          </span>
                        </header>
                        <dl className="key-meta">
                          <div>
                            <dt>Prefix</dt>
                            <dd className="mono" data-testid="service-key-prefix">
                              {key.key_prefix}
                            </dd>
                          </div>
                          <div>
                            <dt>Scope</dt>
                            <dd>{serviceKeyScopeLabel(key, numericEndpointId)}</dd>
                          </div>
                          <div>
                            <dt>Expires</dt>
                            <dd>{key.expires_at ? formatDate(key.expires_at) : "Never"}</dd>
                          </div>
                          <div>
                            <dt>Last used</dt>
                            <dd>{formatDate(key.last_used_at)}</dd>
                          </div>
                          <div>
                            <dt>Created</dt>
                            <dd>{formatDate(key.created_at)}</dd>
                          </div>
                        </dl>
                        {status === "Active" && (
                          <button
                            type="button"
                            className="btn secondary"
                            disabled={Boolean(busy)}
                            data-testid={`revoke-service-key-${key.id}`}
                            title="Permanently disables this API key. It cannot be reactivated."
                            aria-label={`Revoke service key ${key.name}. Permanently disables this API key. It cannot be reactivated.`}
                            onClick={() => void onRevokeKey(key)}
                          >
                            {busy === `revoke-${key.id}` ? "Revoking…" : "Revoke"}
                          </button>
                        )}
                      </article>
                    );
                  })}
                </div>
              )
            )}
          </section>
        </>
      )}

      <Link to={`/projects/${projectId}/deployments`}>← Back to deployments</Link>
    </div>
  );
}
