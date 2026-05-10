import { describe, expect, it } from "vitest";
import { CHAT_PALETTE, colorForName, makeIdentity } from "./chatIdentity";

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
  it("trims surrounding whitespace", () => {
    expect(makeIdentity("  Joel  ").name).toBe("Joel");
  });

  it("caps name length at 32 characters", () => {
    const long = "x".repeat(100);
    const id = makeIdentity(long);
    expect(id.name).toHaveLength(32);
  });

  it("color matches colorForName(cleaned name)", () => {
    const id = makeIdentity("  Joel  ");
    expect(id.color).toBe(colorForName("Joel"));
  });

  it("handles empty input", () => {
    const id = makeIdentity("   ");
    expect(id.name).toBe("");
    expect(CHAT_PALETTE).toContain(id.color);
  });
});
