import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, TOKEN_KEY } from "../api";
import { ErrorNotice, PageHeader, SuccessNotice } from "../components";

export default function ChangePassword() {
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSuccess("");
    if (newPassword !== confirmPassword) {
      setError("New password confirmation does not match.");
      return;
    }
    setBusy(true);
    try {
      await api("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      });
      localStorage.removeItem(TOKEN_KEY);
      setSuccess("Password changed. Redirecting to sign in…");
      window.setTimeout(() => navigate("/login", { replace: true }), 700);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Password could not be changed.");
    } finally {
      setBusy(false);
    }
  }

  return <div>
    <PageHeader title="Change password" description="Update your sign-in password. All current sessions will end." />
    <ErrorNotice message={error} /><SuccessNotice message={success} />
    <form className="panel form" onSubmit={submit}>
      <label>Current password<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label>
      <label>New password<input type="password" autoComplete="new-password" minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
      <label>Confirm new password<input type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></label>
      <button className="btn" disabled={busy}>{busy ? "Changing…" : "Change password"}</button>
    </form>
  </div>;
}
