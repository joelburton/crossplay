import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CHAT_PALETTE,
  colorForName,
  makeIdentity,
  resolveChatIdentity,
} from "./chatIdentity";

// JSDOM in this test runner doesn't reliably provide localStorage, so
// install a minimal in-memory shim before any test reads it. The
// resolveChatIdentity tests below need localStorage to behave like a
// real Storage; the shim does just enough (get/set/remove/clear/length).
beforeAll(() => {
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(k) {
      return store.has(k) ? (store.get(k) as string) : null;
    },
    key(i) {
      return [...store.keys()][i] ?? null;
    },
    removeItem(k) {
      store.delete(k);
    },
    setItem(k, v) {
      store.set(k, String(v));
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: shim,
    configurable: true,
    writable: true,
  });
});

describe("colorForName", () => {
  it("is deterministic for the same name", () => {
    expect(colorForName("Joel")).toBe(colorForName("Joel"));
  });

  it("always picks a color from the palette", () => {
    for (const n of ["a", "Joel", "really long name xyz", "", "🦄"]) {
      expect(CHAT_PALETTE).toContain(colorForName(n));
    }
  });

  it("differs for distinct names that hash differently", () => {
    // Not a guarantee for all pairs (8-color palette, so collisions exist),
    // but these specific names are designed to land on different buckets.
    expect(colorForName("Alice")).not.toBe(colorForName("Bob"));
  });
});

describe("makeIdentity", () => {
  it("color matches colorForName(name)", () => {
    const id = makeIdentity("Joel");
    expect(id.color).toBe(colorForName("Joel"));
  });

  it("passes the name through verbatim", () => {
    expect(makeIdentity("Moth").name).toBe("Moth");
  });
});

describe("resolveChatIdentity", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("returns the account handle for authed users", () => {
    const id = resolveChatIdentity("Moth");
    expect(id.name).toBe("Moth");
    expect(id.color).toBe(colorForName("Moth"));
  });

  it("trims whitespace from the account handle", () => {
    expect(resolveChatIdentity("  Moth  ").name).toBe("Moth");
  });

  it("treats empty/whitespace authed handles as anon", () => {
    const id = resolveChatIdentity("   ");
    expect(id.name).toMatch(/^Rando[0-9]{2}$/);
  });

  it("generates a Rando<NN> for anon users", () => {
    const id = resolveChatIdentity(null);
    expect(id.name).toMatch(/^Rando[0-9]{2}$/);
  });

  it("persists the anon name in localStorage so reloads keep it stable", () => {
    const first = resolveChatIdentity(null);
    const second = resolveChatIdentity(null);
    expect(second.name).toBe(first.name);
  });

  it("ignores a malformed stored anon name and regenerates", () => {
    localStorage.setItem("crossplay.anonName", "not-a-rando-name");
    const id = resolveChatIdentity(null);
    expect(id.name).toMatch(/^Rando[0-9]{2}$/);
    expect(id.name).not.toBe("not-a-rando-name");
  });

  it("doesn't touch the anon-name slot for authed users", () => {
    resolveChatIdentity(null); // seed an anon name
    const seeded = localStorage.getItem("crossplay.anonName");
    expect(seeded).toMatch(/^Rando[0-9]{2}$/);
    resolveChatIdentity("Moth");
    // Authed call shouldn't overwrite the anon slot.
    expect(localStorage.getItem("crossplay.anonName")).toBe(seeded);
  });

  it("uses preferredColor to override the name-hash default", () => {
    const id = resolveChatIdentity("Moth", "#3b82f6");
    expect(id.name).toBe("Moth");
    expect(id.color).toBe("#3b82f6");
  });

  it("lowercases the preferredColor for canonical storage", () => {
    expect(resolveChatIdentity("Moth", "#3B82F6").color).toBe("#3b82f6");
  });

  it("ignores a malformed preferredColor and falls back to the hash default", () => {
    for (const bad of ["red", "#abc", "#12345g", "not a color"]) {
      const id = resolveChatIdentity("Moth", bad);
      expect(id.color).toBe(colorForName("Moth"));
    }
  });

  it("falls back to the hash default when preferredColor is null or missing", () => {
    expect(resolveChatIdentity("Moth", null).color).toBe(colorForName("Moth"));
    expect(resolveChatIdentity("Moth").color).toBe(colorForName("Moth"));
  });
});
