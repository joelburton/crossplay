import { describe, expect, it } from "vitest";
import { previewText } from "./previewText";

describe("previewText", () => {
  it("returns short messages unchanged", () => {
    expect(previewText("hello there")).toBe("hello there");
  });

  it("truncates after 12 words with ellipsis", () => {
    const text = "one two three four five six seven eight nine ten eleven twelve thirteen";
    expect(previewText(text)).toBe("one two three four five six seven eight nine ten eleven twelve...");
  });

  it("strips a leading ! (the important-message marker)", () => {
    expect(previewText("!heads up")).toBe("heads up");
  });

  it("only keeps the first line", () => {
    expect(previewText("first line\nsecond line")).toBe("first line");
  });

  it("strips ! and then takes only the first line", () => {
    expect(previewText("!alert\ndetail")).toBe("alert");
  });

  it("normalizes runs of whitespace when counting words", () => {
    // 13 words separated by tabs/spaces — should still truncate at 12.
    const text = "a b\tc  d e f g h i j k l m";
    expect(previewText(text).endsWith("...")).toBe(true);
  });

  it("handles an empty string", () => {
    expect(previewText("")).toBe("");
  });
});
