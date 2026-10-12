import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api, API_BASE, type AuthResponse, TOKEN_KEY, type User } from "./api";

type AuthMethods = {
  local: boolean;
  oidc: { enabled: boolean; display_name: string | null };
};

type AuthValue = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  completeOidcExchange: (code: string) => Promise<User>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(localStorage.getItem(TOKEN_KEY)));

  useEffect(() => {
    const unauthorized = () => {
      setUser(null);
      setLoading(false);
    };
    window.addEventListener("modelflow:unauthorized", unauthorized);
    return () => window.removeEventListener("modelflow:unauthorized", unauthorized);
  }, []);

  useEffect(() => {
    if (!localStorage.getItem(TOKEN_KEY)) {
      setLoading(false);
      return;
    }
    api<User>("/auth/me")
      .then(setUser)
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      loading,
      login: async (email, password) => {
        const result = await api<AuthResponse>("/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
        localStorage.setItem(TOKEN_KEY, result.access_token);
        setUser(result.user);
      },
      completeOidcExchange: async (code) => {
        const result = await api<AuthResponse>("/auth/oidc/exchange", {
          method: "POST",
          body: JSON.stringify({ code }),
        });
        localStorage.setItem(TOKEN_KEY, result.access_token);
        setUser(result.user);
        return result.user;
      },
      logout: async () => {
        try {
          await api("/auth/logout", { method: "POST" });
        } finally {
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem("modelflow_project_id");
          setUser(null);
        }
      },
    }),
    [loading, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="center-screen" role="status">
        <span className="spinner" />
        Loading your workspace…
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return children;
}

function safeInternalPath(value: string | null | undefined, fallback = "/"): string {
  if (!value) return fallback;
  const path = value.trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
    return fallback;
  }
  return path;
}

export function LoginPage() {
  const { user, login } = useAuth();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(searchParams.get("oidc_error") || "");
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const from = safeInternalPath((location.state as { from?: string } | null)?.from, "/");

  useEffect(() => {
    api<AuthMethods>("/auth/methods")
      .then(setMethods)
      .catch(() => setMethods({ local: true, oidc: { enabled: false, display_name: null } }));
  }, []);

  if (user) return <Navigate to={from} replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(email, password);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }

  function startOidc() {
    const returnTo = encodeURIComponent(from);
    window.location.assign(`${API_BASE}/auth/oidc/start?return_to=${returnTo}`);
  }

  const oidcEnabled = Boolean(methods?.oidc?.enabled);
  const oidcLabel = methods?.oidc?.display_name || "Company SSO";

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand brand-large">
          Model<span>Flow</span>
        </div>
        <div className="eyebrow">MLOps workspace</div>
        <h1 id="login-title">Welcome back</h1>
        <p className="lead">Sign in to build, evaluate, and operate your models.</p>
        {error && <div className="error" role="alert">{error}</div>}
        {oidcEnabled && (
          <div className="form" style={{ marginBottom: "1rem" }}>
            <button
              type="button"
              className="btn btn-wide"
              onClick={startOidc}
              data-testid="login-sso"
            >
              Sign in with {oidcLabel}
            </button>
            <p className="muted" style={{ textAlign: "center", marginTop: "0.75rem" }}>
              or continue with email and password
            </p>
          </div>
        )}
        <form className="form" onSubmit={submit}>
          <label>
            Email
            <input
              autoComplete="username"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              required
              data-testid="login-email"
            />
          </label>
          <label>
            Password
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              data-testid="login-password"
            />
          </label>
          <button className="btn btn-wide" disabled={busy} data-testid="login-submit">
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}

export function OidcCallbackPage() {
  const { user, completeOidcExchange } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [message, setMessage] = useState("Completing sign-in…");

  useEffect(() => {
    const code = searchParams.get("code");
    const returnTo = safeInternalPath(searchParams.get("return_to"), "/");
    if (!code) {
      navigate(`/login?oidc_error=${encodeURIComponent("Sign-in could not be completed.")}`, {
        replace: true,
      });
      return;
    }
    let cancelled = false;
    completeOidcExchange(code)
      .then(() => {
        if (!cancelled) navigate(returnTo, { replace: true });
      })
      .catch((reason) => {
        if (cancelled) return;
        const detail =
          reason instanceof Error ? reason.message : "Sign-in could not be completed.";
        navigate(`/login?oidc_error=${encodeURIComponent(detail)}`, { replace: true });
      });
    return () => {
      cancelled = true;
    };
  }, [completeOidcExchange, navigate, searchParams]);

  if (user) {
    const returnTo = safeInternalPath(searchParams.get("return_to"), "/");
    return <Navigate to={returnTo} replace />;
  }

  return (
    <main className="login-page">
      <section className="login-card" aria-live="polite">
        <div className="brand brand-large">
          Model<span>Flow</span>
        </div>
        <h1>Signing you in</h1>
        <p className="lead">{message}</p>
        <p className="muted">
          <Link to="/login" onClick={() => setMessage("Returning to sign in…")}>
            Back to sign in
          </Link>
        </p>
      </section>
    </main>
  );
}
