/**
 * Tiny hand-rolled SPA router. Two routes only: `/` (home) and
 * `/b/:id` (board). React Router would be overkill — we don't have
 * nested routes, redirects, or loaders.
 *
 * `useRoute` re-renders subscribers when the path changes. Path changes
 * happen via `popstate` (back/forward) or our custom `crossplay:nav`
 * event, dispatched by `navigate()` after `history.pushState`. This
 * indirection is what lets internal navigation skip a full reload while
 * still notifying subscribers in the same tick.
 */

import { useEffect, useState } from "react";

/** Discriminated union of the routes the app understands. */
export type Route = { kind: "home" } | { kind: "board"; id: string };

function parsePath(pathname: string): Route {
  const m = pathname.match(/^\/b\/([^/]+)\/?$/);
  if (m) return { kind: "board", id: decodeURIComponent(m[1]!) };
  return { kind: "home" };
}

/** Subscribe to the current route. Re-renders on browser back/forward
 *  and on programmatic `navigate()` calls. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parsePath(location.pathname));
  useEffect(() => {
    function onPop() {
      setRoute(parsePath(location.pathname));
    }
    window.addEventListener("popstate", onPop);
    window.addEventListener("crossplay:nav", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("crossplay:nav", onPop);
    };
  }, []);
  return route;
}

/** Programmatic navigation. Pushes onto the history stack and notifies
 *  `useRoute` subscribers via the `crossplay:nav` event. No-op if the
 *  target equals the current path. */
export function navigate(to: string): void {
  if (location.pathname === to) return;
  history.pushState({}, "", to);
  window.dispatchEvent(new Event("crossplay:nav"));
}

/** Build the canonical URL for a board id. `encodeURIComponent` covers
 *  ids that aren't already URL-safe (board ids are UUIDs, so this is
 *  belt-and-suspenders today). */
export function boardPath(id: string): string {
  return `/b/${encodeURIComponent(id)}`;
}
