import { expect, test } from "@playwright/test";

/**
 * API-level E2E for Service API Key ↔ External Inference auth separation.
 * Frontend management UI is intentionally out of scope for this PR.
 */

function requiredEnv(name: "E2E_ADMIN_EMAIL" | "E2E_ADMIN_PASSWORD"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Run Playwright through ./scripts/verify.sh.`);
  }
  return value;
}

const adminEmail = requiredEnv("E2E_ADMIN_EMAIL");
const adminPassword = requiredEnv("E2E_ADMIN_PASSWORD");

test("service api key external inference auth separation", async ({ request }) => {
  const tag = Date.now();

  const login = await request.post("/api/v1/auth/login", {
    data: { email: adminEmail, password: adminPassword },
  });
  expect(login.ok()).toBeTruthy();
  const userToken = (await login.json()).access_token as string;
  const userHeaders = { Authorization: `Bearer ${userToken}` };

  const project = await request.post("/api/v1/projects", {
    headers: userHeaders,
    data: { name: `svc-e2e-${tag}`, description: "service key e2e" },
  });
  expect(project.status()).toBe(201);
  const projectId = (await project.json()).id as number;

  const createKey = await request.post(`/api/v1/projects/${projectId}/service-api-keys`, {
    headers: userHeaders,
    data: { name: `e2e-key-${tag}` },
  });
  expect(createKey.status()).toBe(201);
  const created = await createKey.json();
  expect(created.key).toMatch(/^mfk_/);
  expect(created.key_prefix).toMatch(/^mfk_/);
  const plaintext = created.key as string;
  const keyId = created.id as number;
  const keyPrefix = created.key_prefix as string;

  const list = await request.get(`/api/v1/projects/${projectId}/service-api-keys`, {
    headers: userHeaders,
  });
  expect(list.ok()).toBeTruthy();
  const listed = await list.json();
  expect(listed.length).toBe(1);
  expect(listed[0].key).toBeUndefined();
  expect(listed[0].key_hash).toBeUndefined();
  expect(listed[0].key_prefix).toBe(keyPrefix);
  expect(JSON.stringify(listed)).not.toContain(plaintext);

  // User JWT must not authenticate external inference.
  const jwtExternal = await request.post("/api/v1/inference/endpoints/999999/predict", {
    headers: userHeaders,
    data: { instances: [{ a: 1 }] },
  });
  expect(jwtExternal.status()).toBe(401);

  // Authenticated service key + missing endpoint → 404 (auth succeeded, resource missing).
  const missing = await request.post("/api/v1/inference/endpoints/999999/predict", {
    headers: { Authorization: `Bearer ${plaintext}` },
    data: { instances: [{ a: 1 }] },
  });
  expect(missing.status()).toBe(404);

  // Internal predict rejects service key.
  const internal = await request.post("/api/v1/endpoints/999999/predict", {
    headers: { Authorization: `Bearer ${plaintext}` },
    data: { instances: [{ a: 1 }] },
  });
  expect(internal.status()).toBe(401);

  const revoke = await request.post(
    `/api/v1/projects/${projectId}/service-api-keys/${keyId}/revoke`,
    { headers: userHeaders },
  );
  expect(revoke.ok()).toBeTruthy();
  const revokedBody = await revoke.json();
  expect(revokedBody.is_active).toBe(false);
  expect(revokedBody.revoked_at).toBeTruthy();
  expect(revokedBody.key).toBeUndefined();
  expect(JSON.stringify(revokedBody)).not.toContain(plaintext);

  const afterRevoke = await request.post("/api/v1/inference/endpoints/999999/predict", {
    headers: { Authorization: `Bearer ${plaintext}` },
    data: { instances: [{ a: 1 }] },
  });
  expect(afterRevoke.status()).toBe(401);

  const listAgain = await request.get(`/api/v1/projects/${projectId}/service-api-keys`, {
    headers: userHeaders,
  });
  const listedAgain = await listAgain.json();
  expect(JSON.stringify(listedAgain)).not.toContain(plaintext);
  expect(listedAgain[0].key).toBeUndefined();
});
