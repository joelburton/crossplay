import { useEffect, useState } from "react";

export type Route = { kind: "home" } | { kind: "puzzle"; id: string };

function parsePath(pathname: string): Route {
  const m = pathname.match(/^\/p\/([^/]+)\/?$/);
  if (m) return { kind: "puzzle", id: decodeURIComponent(m[1]!) };
  return { kind: "home" };
}

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

export function navigate(to: string): void {
  if (location.pathname === to) return;
  history.pushState({}, "", to);
  window.dispatchEvent(new Event("crossplay:nav"));
}

export function puzzlePath(id: string): string {
  return `/p/${encodeURIComponent(id)}`;
}
