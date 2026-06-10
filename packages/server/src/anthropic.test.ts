import { describe, expect, it } from "vitest";
import { splitScratchpad } from "./anthropic.js";

describe("splitScratchpad", () => {
  it("splits cleanly when the closing tag is present", () => {
    const text =
      "<scratchpad>thinking through anagram</scratchpad>\n**Definition:** cat (furry pet).";
    const res = splitScratchpad(text);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scratchpad).toBe("thinking through anagram");
    expect(res.explanation).toMatch(/\*\*Definition:\*\* cat/);
  });

  it("accepts text without a scratchpad tag (model skipped it)", () => {
    const res = splitScratchpad("**Definition:** cat. **Wordplay:** charade.");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scratchpad).toBe("");
    expect(res.explanation).toMatch(/Definition/);
  });

  it("rejects an empty response (no tag, no text)", () => {
    const res = splitScratchpad("   \n\n  ");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("no_text");
  });

  it("rejects when scratchpad is present but no explanation follows", () => {
    const res = splitScratchpad("<scratchpad>working</scratchpad>   ");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("no_text");
  });

  it("handles a missing opening tag (only closing tag present)", () => {
    const res = splitScratchpad("loose working</scratchpad>**Definition:** x.");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scratchpad).toBe("loose working");
    expect(res.explanation).toBe("**Definition:** x.");
  });
});
