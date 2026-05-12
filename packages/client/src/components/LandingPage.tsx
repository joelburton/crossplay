import { useState } from "react";
import { type AuthUser, HttpError, login, register } from "../api";
import { SiteIcon } from "./SiteIcon";
import styles from "./LandingPage.module.css";

type Props = {
  /** Called when the user successfully logs in or registers. App
   *  swaps from LandingPage → HomePage and honors any `?return=`
   *  path that brought them here. */
  onAuthed: (user: AuthUser) => void;
};

/**
 * Public landing page for anons hitting `/`. Two forms (log in, sign
 * up) side by side on wide screens, stacked on narrow. Explanatory
 * copy reminds the user that board URLs work without an account.
 *
 * No library / no game list / no upload — those are HomePage's job
 * once authed.
 */
export function LandingPage({ onAuthed }: Props) {
  return (
    <div className={styles.outer}>
      <div className={styles.hero}>
        <SiteIcon className={styles.heroIcon} />
        <h1 className={styles.heroTitle}>Crossplay</h1>
      </div>
      <p className={styles.intro}>
        Crossplay is invite-only. Ask a friend for a code, or wait for one of them
        to invite you to a game. If a friend has sent you a board URL, just open
        it &mdash; you don&rsquo;t need an account to play that one board.
      </p>
      <div className={styles.forms}>
        <LoginForm onAuthed={onAuthed} />
        <RegisterForm onAuthed={onAuthed} />
      </div>
    </div>
  );
}

type FormProps = { onAuthed: (user: AuthUser) => void };

/** Server-error to user-message coercion. The auth routes return
 *  user-friendly messages in `{error}` already; we just pass them
 *  through, with a generic fallback for the network-failure case. */
function errorMessage(err: unknown): string {
  if (err instanceof HttpError) return err.message;
  return "Something went wrong. Try again.";
}

function LoginForm({ onAuthed }: FormProps) {
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const user = await login({ handle, password });
      onAuthed(user);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} aria-label="Log in">
      <h2 className={styles.formTitle}>Log in</h2>
      <label className={styles.field}>
        <span>Handle</span>
        <input
          type="text"
          autoComplete="username"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          required
        />
      </label>
      <label className={styles.field}>
        <span>Password</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      {error && <p className={styles.error}>{error}</p>}
      <button type="submit" className={styles.submit} disabled={busy}>
        {busy ? "Logging in…" : "Log in"}
      </button>
    </form>
  );
}

function RegisterForm({ onAuthed }: FormProps) {
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const user = await register({ handle, password, inviteCode });
      onAuthed(user);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} aria-label="Sign up">
      <h2 className={styles.formTitle}>Sign up</h2>
      <label className={styles.field}>
        <span>Handle</span>
        <input
          type="text"
          autoComplete="username"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          required
        />
      </label>
      <label className={styles.field}>
        <span>Password</span>
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      <label className={styles.field}>
        <span>Invite code</span>
        <input
          type="text"
          value={inviteCode}
          onChange={(e) => setInviteCode(e.target.value)}
          required
        />
      </label>
      {error && <p className={styles.error}>{error}</p>}
      <button type="submit" className={styles.submit} disabled={busy}>
        {busy ? "Signing up…" : "Sign up"}
      </button>
    </form>
  );
}
