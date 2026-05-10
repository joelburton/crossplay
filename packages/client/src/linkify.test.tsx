import { isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { linkify } from "./linkify";

function asArray(node: ReactNode): ReactNode[] {
  return Array.isArray(node) ? node : [node];
}

function isAnchor(n: ReactNode): n is ReactElement<{ href: string; children: string }> {
  return isValidElement(n) && n.type === "a";
}

describe("linkify", () => {
  it("returns the text wrapped in an array when no URL is present", () => {
    // No regex matches → falls through to the trailing push, yielding a
    // single-element array containing the original string. React renders
    // it the same as a bare string.
    expect(linkify("just words")).toEqual(["just words"]);
  });

  it("returns the empty string for empty input", () => {
    expect(linkify("")).toBe("");
  });

  it("wraps a single bare URL in an anchor", () => {
    const out = asArray(linkify("see https://example.com here"));
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("see ");
    expect(isAnchor(out[1])).toBe(true);
    if (isAnchor(out[1])) {
      expect(out[1].props.href).toBe("https://example.com");
      expect(out[1].props.children).toBe("https://example.com");
    }
    expect(out[2]).toBe(" here");
  });

  it("strips trailing punctuation off the URL but keeps it as text", () => {
    const out = asArray(linkify("go to https://example.com."));
    // ["go to ", <a>https://example.com</a>, "."]
    expect(out).toHaveLength(3);
    expect(isAnchor(out[1])).toBe(true);
    if (isAnchor(out[1])) {
      expect(out[1].props.href).toBe("https://example.com");
    }
    expect(out[2]).toBe(".");
  });

  it("strips multiple trailing punctuation chars", () => {
    const out = asArray(linkify("(see https://example.com/foo)."));
    // The closing ")." should be split off the URL.
    const anchor = out.find(isAnchor);
    expect(anchor).toBeTruthy();
    if (anchor) expect(anchor.props.href).toBe("https://example.com/foo");
    // The trailing piece kept after the anchor must include ").".
    const trailing = out[out.length - 1];
    expect(typeof trailing).toBe("string");
    expect(trailing).toBe(").");
  });

  it("handles two URLs in a row", () => {
    const out = asArray(linkify("a https://x.test b https://y.test c"));
    const anchors = out.filter(isAnchor);
    expect(anchors).toHaveLength(2);
    expect(anchors[0]!.props.href).toBe("https://x.test");
    expect(anchors[1]!.props.href).toBe("https://y.test");
  });

  it("uses target=_blank and rel=noopener noreferrer", () => {
    const out = asArray(linkify("https://example.com"));
    const anchor = out.find(isAnchor);
    expect(anchor).toBeTruthy();
    if (anchor) {
      expect(anchor.props).toMatchObject({
        target: "_blank",
        rel: "noopener noreferrer",
      });
    }
  });

  it("supports http: as well as https:", () => {
    const out = asArray(linkify("plain http://example.com"));
    const anchor = out.find(isAnchor);
    expect(anchor).toBeTruthy();
    if (anchor) expect(anchor.props.href).toBe("http://example.com");
  });
});
