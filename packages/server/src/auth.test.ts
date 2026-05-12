import { describe, expect, it } from "vitest";
import {
  HANDLE_RE,
  MIN_PASSWORD_LENGTH,
  createSession,
  createUser,
  deleteSession,
  findSession,
  findUserByHandle,
  hashPassword,
  inviteCodeExists,
  isExpired,
  newSessionToken,
  normalizeHandle,
  touchSession,
  validateHandle,
  verifyPassword,
} from "./auth.js";
import { openDb } from "./db.js";

describe("hashPassword + verifyPassword", () => {
  it("round-trips a correct password", () => {
    const h = hashPassword("hunter2");
    expect(verifyPassword("hunter2", h)).toBe(true);
  });

  it("rejects the wrong password", () => {
    const h = hashPassword("hunter2");
    expect(verifyPassword("hunter3", h)).toBe(false);
  });

  it("produces different hashes for the same password (fresh salt each call)", () => {
    const a = hashPassword("hunter2");
    const b = hashPassword("hunter2");
    expect(a).not.toBe(b);
    expect(verifyPassword("hunter2", a)).toBe(true);
    expect(verifyPassword("hunter2", b)).toBe(true);
  });

  it("returns false for malformed stored hashes rather than throwing", () => {
    expect(verifyPassword("anything", "")).toBe(false);
    expect(verifyPassword("anything", "not$a$hash")).toBe(false);
    expect(verifyPassword("anything", "scrypt$x$y$z$bad$bad")).toBe(false);
  });

  it("stored format begins with scrypt$ and is self-describing", () => {
    const h = hashPassword("hunter2");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(h.split("$").length).toBe(6);
  });
});

describe("validateHandle", () => {
  it("accepts lowercase letters, digits, underscore, hyphen", () => {
    expect(validateHandle("moth")).toBe("moth");
    expect(validateHandle("dr_anagram")).toBe("dr_anagram");
    expect(validateHandle("user-42")).toBe("user-42");
    expect(validateHandle("ab")).toBe("ab"); // min length
    expect(validateHandle("a".repeat(32))).toBe("a".repeat(32)); // max length
  });

  it("normalizes case", () => {
    expect(validateHandle("Moth")).toBe("moth");
    expect(validateHandle("DrAnagram")).toBe("dranagram");
  });

  it("trims surrounding whitespace", () => {
    expect(validateHandle("  moth  ")).toBe("moth");
  });

  it("rejects too short / too long / weird punctuation / empty", () => {
    expect(validateHandle("")).toBeNull();
    expect(validateHandle("   ")).toBeNull();
    expect(validateHandle("a")).toBeNull();
    expect(validateHandle("a".repeat(33))).toBeNull();
    expect(validateHandle("moth!")).toBeNull();
    expect(validateHandle("moth.dev")).toBeNull();
    expect(validateHandle("moth@example")).toBeNull();
    expect(validateHandle("two words")).toBeNull();
  });

  it("rejects non-strings defensively", () => {
    expect(validateHandle(undefined as unknown as string)).toBeNull();
    expect(validateHandle(null as unknown as string)).toBeNull();
    expect(validateHandle(42 as unknown as string)).toBeNull();
  });

  it("regex matches the documented shape", () => {
    expect(HANDLE_RE.source).toBe("^[a-z0-9_-]{2,32}$");
  });
});

describe("normalizeHandle", () => {
  it("lowercases", () => {
    expect(normalizeHandle("MOTH")).toBe("moth");
  });
});

describe("newSessionToken", () => {
  it("returns a 64-char hex string", () => {
    const t = newSessionToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different token each time", () => {
    expect(newSessionToken()).not.toBe(newSessionToken());
  });
});

describe("MIN_PASSWORD_LENGTH", () => {
  it("is 6", () => {
    // Pinned so the rule doesn't drift unnoticed.
    expect(MIN_PASSWORD_LENGTH).toBe(6);
  });
});

describe("DB-backed auth helpers", () => {
  function setup() {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO invite_codes (code, label, created_at) VALUES (?, ?, ?)",
    ).run("cryptic-night", "close circle", "2026-05-12");
    return db;
  }

  it("inviteCodeExists matches case-insensitively", () => {
    const db = setup();
    expect(inviteCodeExists(db, "cryptic-night")).toBe(true);
    expect(inviteCodeExists(db, "CRYPTIC-NIGHT")).toBe(true);
    expect(inviteCodeExists(db, "Cryptic-Night")).toBe(true);
    expect(inviteCodeExists(db, "no-such-code")).toBe(false);
  });

  it("createUser + findUserByHandle round-trip", () => {
    const db = setup();
    const id = createUser(db, {
      handle: "Moth",
      handleLower: "moth",
      passwordHash: hashPassword("hunter2"),
      inviteCodeUsed: "cryptic-night",
    });
    expect(id).toBeGreaterThan(0);

    const found = findUserByHandle(db, "moth");
    expect(found).toBeDefined();
    expect(found!.handle).toBe("Moth"); // case preserved
    expect(found!.handle_lower).toBe("moth");
    expect(found!.invite_code_used).toBe("cryptic-night");
    expect(found!.is_admin).toBe(0);
    expect(verifyPassword("hunter2", found!.password_hash)).toBe(true);
  });

  it("session create/find/touch/delete round-trip", () => {
    const db = setup();
    const userId = createUser(db, {
      handle: "moth",
      handleLower: "moth",
      passwordHash: hashPassword("hunter2"),
      inviteCodeUsed: null,
    });
    const token = createSession(db, userId);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const session = findSession(db, token);
    expect(session).toBeDefined();
    expect(session!.user_id).toBe(userId);
    expect(isExpired(session!)).toBe(false);

    // touchSession pushes expires_at forward.
    const firstExpiry = Date.parse(session!.expires_at);
    // Wait a few ms so the new expiry is measurably later.
    const wait = Date.now() + 5;
    while (Date.now() < wait) { /* spin */ }
    touchSession(db, token);
    const second = findSession(db, token);
    expect(Date.parse(second!.expires_at)).toBeGreaterThanOrEqual(firstExpiry);

    deleteSession(db, token);
    expect(findSession(db, token)).toBeUndefined();
  });

  it("deleteSession is idempotent", () => {
    const db = setup();
    expect(() => deleteSession(db, "nope")).not.toThrow();
  });

  it("isExpired returns true past expires_at", () => {
    const past = {
      id: "x",
      user_id: 1,
      created_at: "2020-01-01",
      last_seen_at: "2020-01-01",
      expires_at: "2020-01-02",
    };
    expect(isExpired(past)).toBe(true);
  });
});
