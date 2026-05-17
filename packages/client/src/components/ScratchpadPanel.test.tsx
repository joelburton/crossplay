// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScratchpadPanel, type ScratchpadLock } from "./ScratchpadPanel";

const identity = { name: "Alice", color: "#1f77b4" };
const other: ScratchpadLock = { name: "Bob", color: "#ff7f0e" };

function setup(overrides: {
  text?: string;
  lockedBy?: ScratchpadLock | null;
} = {}) {
  const onEdit = vi.fn();
  const onTakeover = vi.fn();
  const onClose = vi.fn();
  render(
    <ScratchpadPanel
      identity={identity}
      text={overrides.text ?? ""}
      lockedBy={overrides.lockedBy ?? null}
      onEdit={onEdit}
      onTakeover={onTakeover}
      onClose={onClose}
    />,
  );
  return {
    onEdit,
    onTakeover,
    onClose,
    textarea: screen.getByPlaceholderText(/./) as HTMLTextAreaElement,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("ScratchpadPanel", () => {
  it("renders the lock owner's name when someone else is editing", () => {
    setup({ text: "shared", lockedBy: other });
    expect(screen.getByText(/Bob/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /take over/i })).toBeTruthy();
  });

  it("disables the textarea when not the holder", () => {
    const { textarea } = setup({ text: "shared", lockedBy: other });
    expect(textarea.disabled).toBe(true);
    expect(textarea.value).toBe("shared");
  });

  it("enables the textarea when you hold the lock", () => {
    const { textarea } = setup({ text: "yours", lockedBy: identity });
    expect(textarea.disabled).toBe(false);
  });

  it("shows an Edit button when nobody holds the lock", () => {
    setup({ text: "", lockedBy: null });
    expect(screen.getByRole("button", { name: /edit/i })).toBeTruthy();
  });

  it("fires onTakeover when the take-over button is clicked", () => {
    const { onTakeover } = setup({ text: "x", lockedBy: other });
    fireEvent.click(screen.getByRole("button", { name: /take over/i }));
    expect(onTakeover).toHaveBeenCalledTimes(1);
  });

  it("debounces text edits and sends the latest value once", () => {
    const { textarea, onEdit } = setup({ text: "", lockedBy: identity });
    fireEvent.change(textarea, { target: { value: "h" } });
    fireEvent.change(textarea, { target: { value: "he" } });
    fireEvent.change(textarea, { target: { value: "hel" } });
    expect(onEdit).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onEdit).toHaveBeenCalledExactlyOnceWith("hel");
  });

  it("re-syncs the textarea from props when the lock transfers away", () => {
    const { textarea, rerender } = renderWithRerender({
      text: "mine",
      lockedBy: identity,
    });
    fireEvent.change(textarea, { target: { value: "mine + drift" } });
    expect(textarea.value).toBe("mine + drift");
    // Lock taken over by Bob; server-authoritative text wins.
    rerender({ text: "canonical", lockedBy: other });
    expect(textarea.value).toBe("canonical");
    expect(textarea.disabled).toBe(true);
  });

  it("ignores incoming text while you hold the lock (no echo flicker)", () => {
    const { textarea, rerender } = renderWithRerender({
      text: "initial",
      lockedBy: identity,
    });
    fireEvent.change(textarea, { target: { value: "draft ahead" } });
    // A stale server echo arrives — local draft should stick.
    rerender({ text: "initial", lockedBy: identity });
    expect(textarea.value).toBe("draft ahead");
  });
});

function renderWithRerender(initial: {
  text: string;
  lockedBy: ScratchpadLock | null;
}) {
  const onEdit = vi.fn();
  const onTakeover = vi.fn();
  const onClose = vi.fn();
  const { rerender: rrr } = render(
    <ScratchpadPanel
      identity={identity}
      text={initial.text}
      lockedBy={initial.lockedBy}
      onEdit={onEdit}
      onTakeover={onTakeover}
      onClose={onClose}
    />,
  );
  return {
    textarea: screen.getByPlaceholderText(/./) as HTMLTextAreaElement,
    rerender(next: { text: string; lockedBy: ScratchpadLock | null }) {
      rrr(
        <ScratchpadPanel
          identity={identity}
          text={next.text}
          lockedBy={next.lockedBy}
          onEdit={onEdit}
          onTakeover={onTakeover}
          onClose={onClose}
        />,
      );
    },
  };
}
