import { useCallback, useEffect, useRef, useState } from "react";
import type { PuzzleState } from "@crossplay/shared";
import { type AuthUser, HttpError, fetchBoard, fetchMe, logout as apiLogout } from "./api";
import { boardPath, navigate, useRoute } from "./routing";
import type { PuzzleActions } from "./puzzleActions";
import { FeedbackBar } from "./components/FeedbackBar";
import { HomePage } from "./components/HomePage";
import { LandingPage } from "./components/LandingPage";
import { Menu } from "./components/Menu";
import { ModeButton } from "./components/ModeButton";
import { SiteIcon } from "./components/SiteIcon";
import { UserMenu } from "./components/UserMenu";
import { UploadForm } from "./components/UploadForm";
import { PuzzleView, type Mode, type Presence } from "./components/PuzzleView";
import type { Feedback } from "./feedback";
import styles from "./App.module.css";

/** Auth state. "loading" only on the initial /api/auth/me probe;
 *  every render after that is either "anon" or a resolved user. */
type AuthState =
  | { kind: "loading" }
  | { kind: "anon" }
  | { kind: "user"; user: AuthUser };

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; puzzle: PuzzleState }
  | { kind: "error"; message: string };

/**
 * Top-level component. Owns:
 *  - the route (home vs puzzle, via the hand-rolled router in routing.ts);
 *  - the load state for the current puzzle;
 *  - pen/pencil mode (here, not in PuzzleView, so the always-visible
 *    ModeButton in the header re-renders on toggle);
 *  - the header feedback bar with its auto-vanish timer.
 *
 * Renders either HomePage (no puzzle) or PuzzleView (loaded). The Menu
 * reads its actions from a ref written by PuzzleView; see puzzleActions.ts.
 */
export function App() {
  const route = useRoute();
  const [load, setLoad] = useState<LoadState>({ kind: "idle" });
  const [auth, setAuth] = useState<AuthState>({ kind: "loading" });
  const [menuOpen, setMenuOpen] = useState(false);

  // Probe /api/auth/me once on mount. The cookie rides natively; a
  // 401 means we're anon, a 200 carries the user. Network failure is
  // treated as anon — better to show the landing page than a blank.
  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((user) => {
        if (cancelled) return;
        setAuth(user ? { kind: "user", user } : { kind: "anon" });
      })
      .catch(() => {
        if (cancelled) return;
        setAuth({ kind: "anon" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onAuthed = useCallback((user: AuthUser) => {
    setAuth({ kind: "user", user });
    // Return-after-login: future-proofing. If a deep link routed
    // through the landing page with ?return=/foo, send the user back.
    // (No producers of this query param yet — Phase 1 doesn't have
    // any auth-required deep links — but the consumer side is cheap
    // to wire now.)
    try {
      const url = new URL(window.location.href);
      const ret = url.searchParams.get("return");
      if (ret && ret.startsWith("/")) {
        navigate(ret);
      }
    } catch {
      // ignore; malformed URL → stay on / which now shows HomePage
    }
  }, []);

  const onLogout = useCallback(async () => {
    try {
      await apiLogout();
    } catch {
      // Server-side logout failed; still flip the client state so
      // the user isn't stuck "logged in" from their perspective.
    }
    setAuth({ kind: "anon" });
    setMenuOpen(false);
    setLoad({ kind: "idle" });
    navigate("/");
  }, []);

  // Live player roster reported by PuzzleView (me + WS peers). Drives
  // the colored-dot list in the header slot, replaced by the
  // FeedbackBar pill when feedback is active. Updates on join / leave
  // / rename, not on every cursor move — see PuzzleView's
  // `onPresenceChange` for the stability story.
  const [presence, setPresence] = useState<Presence[]>([]);
  const [mode, setMode] = useState<Mode>("pen");
  // Persisted across sessions: collapse-rebuses preference. Display
  // only — server-side fills stay full. localStorage read is wrapped
  // because SSR / privacy modes can throw on access.
  const [collapseRebus, setCollapseRebus] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("collapseRebus") === "1";
    } catch {
      return false;
    }
  });
  const toggleCollapseRebus = useCallback(() => {
    setCollapseRebus((v) => {
      const next = !v;
      try {
        window.localStorage.setItem("collapseRebus", next ? "1" : "0");
      } catch {
        // ignore: read-only storage just means we don't persist
      }
      return next;
    });
  }, []);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onPresenceChange = useCallback((p: Presence[]) => setPresence(p), []);
  const onToggleMode = useCallback(
    () => setMode((m) => (m === "pen" ? "pencil" : "pen")),
    [],
  );
  const dismissFeedback = useCallback(() => {
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
    setFeedback(null);
  }, []);

  const showFeedback = useCallback((f: Feedback) => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    setFeedback(f);
    if (f.autoVanishMs && f.autoVanishMs > 0) {
      feedbackTimerRef.current = setTimeout(() => {
        feedbackTimerRef.current = null;
        setFeedback((cur) => (cur && cur.id === f.id ? null : cur));
      }, f.autoVanishMs);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    };
  }, []);
  const actionsRef = useRef<PuzzleActions | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadById(id: string) {
      setLoad({ kind: "loading" });
      try {
        const p = await fetchBoard(id);
        if (!cancelled) {
          // Dev-only: dump the board the server handed us so the
          // network response can be inspected without DevTools. The
          // `import.meta.env.DEV` check is statically replaced at
          // build time, so this block is dead-code-eliminated from
          // production bundles.
          if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.log("[crossplay] board loaded", id, p);
          }
          setLoad({ kind: "loaded", puzzle: p });
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof HttpError && err.status === 404) {
          navigate("/");
          return;
        }
        setLoad({
          kind: "error",
          message: err instanceof Error ? err.message : "failed to load",
        });
      }
    }

    if (route.kind === "board") {
      void loadById(route.id);
    } else {
      setLoad({ kind: "idle" });
    }

    return () => {
      cancelled = true;
    };
  }, [route]);

  // close menu / clear presence / reset mode when puzzle changes.
  // Show the welcome feedback once per browser (localStorage flag);
  // returning users have learned where the menu is. When real users
  // exist, this should move from per-browser to per-user.
  useEffect(() => {
    setMenuOpen(false);
    setPresence([]);
    setMode("pen");
    if (load.kind === "loaded") {
      let seen = false;
      try {
        seen = window.localStorage.getItem("seenWelcome") === "1";
      } catch {
        // ignore: privacy-mode storage just means we re-show
      }
      if (!seen) {
        showFeedback({
          id: `welcome-${load.puzzle.meta.id}`,
          // Red heart matches the SiteIcon in the title; ⌥ is the
          // standard Mac Option-key glyph (U+2325). Both render as
          // inline characters — no SVG to load, no asset to ship.
          text: (
            <>
              Click <span style={{ color: "#dc2626" }}>♥</span>/⌥M for menu
            </>
          ),
          level: "info",
        });
        try {
          window.localStorage.setItem("seenWelcome", "1");
        } catch {
          // ignore: read-only storage just means we'll show it again next load
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load.kind === "loaded" ? load.puzzle.meta.id : null]);

  function onUploaded(boardId: string) {
    navigate(boardPath(boardId));
  }

  function onNewGame() {
    setLoad({ kind: "idle" });
    setMenuOpen(false);
    setPresence([]);
    navigate("/");
  }

  // Home page (`load.kind === "idle"`) gets its own hero header inside
  // HomePage / LandingPage — no shared top bar, no menu, no welcome
  // feedback there. The board route keeps the small top-left title +
  // menu + feedback slot.
  const showHeader = load.kind !== "idle";

  // Decide what to render at `/`. Three states:
  //   - auth still loading: render nothing visible (avoid the
  //     anon→user flicker when the cookie probe resolves quickly).
  //   - anon: LandingPage.
  //   - user: HomePage.
  // The board route bypasses this entirely — URLs are public.
  function renderHome() {
    if (auth.kind === "loading") return null;
    if (auth.kind === "anon") return <LandingPage onAuthed={onAuthed} />;
    return <HomePage onUploaded={onUploaded} user={auth.user} onLogout={onLogout} />;
  }

  // When authed, reserve horizontal space at the top-right for the
  // fixed-position `UserMenu` tab. `ChatIndicator` and `ChatPreview`
  // both add `--user-menu-offset` into their `right` so the chat
  // bubble doesn't sit underneath the tab. Anons don't render the
  // tab, so the offset stays at 0.
  const appStyle: React.CSSProperties | undefined =
    auth.kind === "user"
      ? ({ ["--user-menu-offset" as never]: "9.5rem" } as React.CSSProperties)
      : undefined;

  return (
    <div className={styles.app} style={appStyle}>
      {showHeader && (
        <header className={styles.header}>
          <div className={styles.titleWrap}>
            <h1
              ref={titleRef}
              className={styles.title}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <SiteIcon className={styles.icon} />
              <span className={styles.titleText}>Crossplay</span>
            </h1>
            {menuOpen && (
              <Menu
                actions={actionsRef.current}
                triggerRef={titleRef}
                onNewGame={onNewGame}
                onClose={() => setMenuOpen(false)}
              />
            )}
          </div>
          {load.kind === "loaded" && <ModeButton mode={mode} onToggle={onToggleMode} />}
          <div className={styles.headerSlot}>
            {feedback ? (
              <FeedbackBar feedback={feedback} onDismiss={dismissFeedback} />
            ) : presence.length > 0 ? (
              // Up to 4 entries — at the friend-group scale this is the
              // realistic ceiling. If more peers join we silently truncate;
              // the chat indicator + chat panel are the channel for
              // "everyone in the room" when it matters.
              <ul className={styles.presence} aria-label="Players in this board">
                {presence.slice(0, 4).map((p) => (
                  <li
                    key={`${p.color}:${p.name}`}
                    className={styles.presenceEntry}
                    title={p.isMe ? `${p.name} (you)` : p.name}
                  >
                    <span
                      className={styles.presenceDot}
                      style={{ background: p.color }}
                      aria-hidden="true"
                    />
                    <span className={styles.presenceName}>{p.name}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <span>&nbsp;</span>
            )}
          </div>
        </header>
      )}
      {auth.kind === "user" && (
        // Rendered at the App level, not inside the header, because
        // it's fixed-positioned anyway (a tab stuck to the top-right
        // of the viewport). Same component on the home page.
        <UserMenu handle={auth.user.handle} onLogout={onLogout} />
      )}
      <main className={styles.main}>
        {load.kind === "loading" && <p>Loading…</p>}
        {load.kind === "error" && (
          <div>
            <p style={{ color: "#c00" }}>{load.message}</p>
            <UploadForm onUploaded={onUploaded} />
          </div>
        )}
        {load.kind === "loaded" && (
          <PuzzleView
            puzzle={load.puzzle}
            mode={mode}
            onToggleMode={onToggleMode}
            collapseRebus={collapseRebus}
            onToggleCollapseRebus={toggleCollapseRebus}
            actionsRef={actionsRef}
            onPresenceChange={onPresenceChange}
            onFeedback={showFeedback}
            onActivity={dismissFeedback}
            feedbackVisible={feedback != null}
            onToggleMenu={() => setMenuOpen((o) => !o)}
            onNewGame={onNewGame}
            authedHandle={auth.kind === "user" ? auth.user.handle : null}
          />
        )}
        {load.kind === "idle" && renderHome()}
      </main>
    </div>
  );
}
