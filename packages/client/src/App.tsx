import { useCallback, useEffect, useRef, useState } from "react";
import type { PuzzleState } from "@crossplay/shared";
import {
  type AuthUser,
  HttpError,
  fetchBoard,
  fetchMe,
  logout as apiLogout,
  markHelpSeen as apiMarkHelpSeen,
} from "./api";
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
import { PrintPage } from "./components/PrintPage";
import { PuzzleView, type Mode } from "./components/PuzzleView";
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

  // Backtick stands in for Escape on mobile / tablet hardware keyboards
  // that lack an Esc key (a real complaint from iPad-with-keyboard
  // testing). Capture-phase so we beat any element-level handler;
  // re-dispatch as a synthetic Escape on the focused element so every
  // existing Esc handler keeps working unchanged. The cost is that
  // `` ` `` can never be typed into a focused input — there's exactly
  // one input that accepts text where that matters (chat), and `
  // is rare enough in casual chat to be a fair trade for the
  // accessibility win.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.isTrusted) return; // skip our own re-dispatch
      if (e.key !== "`") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.isComposing) return; // IME mid-composition
      e.preventDefault();
      e.stopPropagation();
      const target = (document.activeElement as HTMLElement | null) ?? document.body;
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // PuzzleView owns the chat + presence state and renders the chat
  // indicator + presence-or-preview content via React portals into
  // these header slots. App keeps the slots so it can collapse them
  // when the feedback bar takes over the middle area.
  const [chatSlot, setChatSlot] = useState<HTMLDivElement | null>(null);
  const [presenceSlot, setPresenceSlot] = useState<HTMLDivElement | null>(null);
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
      // Home AND print both leave the App-level load state idle. Print
      // does its own fetch inside PrintPage so it never touches this
      // pipeline (no shared header / mode / feedback to set up).
      setLoad({ kind: "idle" });
    }

    return () => {
      cancelled = true;
    };
  }, [route]);

  // close menu / reset mode when puzzle changes.
  useEffect(() => {
    setMenuOpen(false);
    setMode("pen");
  }, [load.kind === "loaded" ? load.puzzle.meta.id : null]);

  // First-visit help-dialog auto-open. For authed users the
  // `seenHelpAt` timestamp lives on the user row (admin can clear via
  // SQL when help changes meaningfully — `UPDATE users SET
  // seen_help_at = NULL` etc.). For anons we use the
  // `crossplay.seenHelpAt` localStorage key. Either way, "unseen" =>
  // PuzzleView auto-opens HelpDialog on first board mount; the
  // dismissal callback flips the flag.
  const seenHelp: boolean | undefined = (() => {
    if (auth.kind === "user") return auth.user.seenHelpAt !== null;
    if (auth.kind === "anon") {
      try {
        return window.localStorage.getItem("crossplay.seenHelpAt") !== null;
      } catch {
        // privacy-mode storage → treat as seen so we don't loop
        return true;
      }
    }
    // auth.kind === "loading": don't commit either way yet. PuzzleView
    // waits for a defined value before deciding whether to auto-open.
    return undefined;
  })();

  const onHelpSeen = useCallback(() => {
    if (auth.kind === "user") {
      // Optimistic local update so a same-session navigation back to
      // a board doesn't re-trigger the dialog before the POST settles.
      setAuth({
        kind: "user",
        user: { ...auth.user, seenHelpAt: new Date().toISOString() },
      });
      void apiMarkHelpSeen().catch(() => {
        // Server is offline / hiccupped. Worst case the dialog re-shows
        // next session; not worth surfacing.
      });
    } else if (auth.kind === "anon") {
      try {
        window.localStorage.setItem("crossplay.seenHelpAt", new Date().toISOString());
      } catch {
        // privacy mode: dialog will re-show next load. Acceptable.
      }
    }
  }, [auth]);

  function onUploaded(boardId: string) {
    navigate(boardPath(boardId));
  }

  function onNewGame() {
    setLoad({ kind: "idle" });
    setMenuOpen(false);
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

  // Print route bypasses every App chrome element: no header, no auth
  // probe, no user menu, no mode button, no menu. PrintPage runs its
  // own fetch + render entirely; we hand off the whole document area.
  if (route.kind === "print") {
    return <PrintPage boardId={route.id} />;
  }

  return (
    <div className={styles.app}>
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
          {load.kind === "loaded" && (
            <div className={styles.divider} aria-hidden="true" />
          )}
          {/* Middle area. When feedback is active it spans both slots
              and the chat / presence content hides; otherwise PuzzleView
              portals the chat indicator into `chatSlotRef` and the
              presence-or-preview content into `presenceSlotRef`. */}
          <div className={styles.middle}>
            {feedback ? (
              <FeedbackBar feedback={feedback} onDismiss={dismissFeedback} />
            ) : (
              <>
                <div ref={setChatSlot} className={styles.chatSlot} />
                <div ref={setPresenceSlot} className={styles.presenceSlot} />
              </>
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
            chatSlot={chatSlot}
            presenceSlot={presenceSlot}
            onFeedback={showFeedback}
            onActivity={dismissFeedback}
            feedbackVisible={feedback != null}
            onToggleMenu={() => setMenuOpen((o) => !o)}
            onNewGame={onNewGame}
            authedHandle={auth.kind === "user" ? auth.user.handle : null}
            seenHelp={seenHelp}
            onHelpSeen={onHelpSeen}
          />
        )}
        {load.kind === "idle" && renderHome()}
      </main>
      {load.kind === "loaded" && (
        // Print-only fallback. Hidden on screen; @media print swaps it
        // in (and hides every other direct child of .app) when the
        // user hits Cmd/Ctrl+P from a board page. The play UI doesn't
        // print well — direct them to the dedicated PDF route instead.
        <aside className={styles.printNotice} aria-hidden="true">
          <h1>Use the PDF, not browser print</h1>
          <p>
            The live board page doesn't print correctly — the grid and
            clue panels are sized for a screen, not a page.
          </p>
          <p>
            To get a clean printable version, open the menu (click the
            title at the top-left) and choose <code>Print / Save as PDF</code>.
            That opens a dedicated tab with a real PDF you can save or print.
          </p>
        </aside>
      )}
    </div>
  );
}
