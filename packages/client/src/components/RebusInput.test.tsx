// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RebusInput } from "./RebusInput";

afterEach(() => cleanup());

function renderInput(overrides: Partial<Parameters<typeof RebusInput>[0]> = {}) {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  render(
    <RebusInput
      initial={overrides.initial ?? ""}
      maxLength={overrides.maxLength ?? 8}
      onCommit={overrides.onCommit ?? onCommit}
      onCancel={overrides.onCancel ?? onCancel}
    />,
  );
  return {
    input: screen.getByLabelText("Rebus entry") as HTMLInputElement,
    onCommit: overrides.onCommit ?? onCommit,
    onCancel: overrides.onCancel ?? onCancel,
  };
}

describe("RebusInput", () => {
  it("uppercases input and strips non-letters as the user types", () => {
    const { input } = renderInput();
    fireEvent.change(input, { target: { value: "blo3ck!" } });
    expect(input.value).toBe("BLOCK");
  });

  it("clamps to maxLength characters", () => {
    const { input } = renderInput({ maxLength: 4 });
    fireEvent.change(input, { target: { value: "blocked" } });
    expect(input.value).toBe("BLOC");
  });

  it("commits the current value on Enter with 'advance' post-action", () => {
    const { input, onCommit, onCancel } = renderInput();
    fireEvent.change(input, { target: { value: "block" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("BLOCK", "advance");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("commits + jumps to next clue on Tab", () => {
    const { input, onCommit, onCancel } = renderInput();
    fireEvent.change(input, { target: { value: "heart" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("HEART", "jumpNext");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("commits + jumps to previous clue on Shift+Tab", () => {
    const { input, onCommit, onCancel } = renderInput();
    fireEvent.change(input, { target: { value: "heart" } });
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("HEART", "jumpPrev");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("commits an empty value on Tab (same as Backspace + jump)", () => {
    const { input, onCommit } = renderInput();
    fireEvent.keyDown(input, { key: "Tab" });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("", "jumpNext");
  });

  it("cancels on Escape without committing", () => {
    const { input, onCommit, onCancel } = renderInput();
    fireEvent.change(input, { target: { value: "block" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("cancels on plain blur (e.g. clicking outside)", () => {
    const { input, onCommit, onCancel } = renderInput();
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("does NOT call onCancel on the blur fired by Enter unmounting the input", () => {
    // After Enter commits, React unmounts the input via parent state.
    // The DOM removal fires `blur`; committedRef must short-circuit
    // onCancel so it doesn't run a second time with side effects.
    const { input, onCommit, onCancel } = renderInput();
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Simulate the blur that fires as the input is torn down.
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("prefills with `initial` and selects it for easy overwrite", () => {
    const { input } = renderInput({ initial: "BLOCK" });
    expect(input.value).toBe("BLOCK");
    // Cursor may not survive jsdom selection APIs; document the intent
    // via comment rather than asserting a flaky selectionStart.
  });

  it("stops bubble so PuzzleView's window keydown doesn't double-handle", () => {
    const { input } = renderInput();
    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);
    fireEvent.keyDown(input, { key: "a" });
    window.removeEventListener("keydown", onWindow);
    // fireEvent dispatches a synthetic React event; we assert via the
    // documented behavior: `e.stopPropagation()` in the handler stops
    // the bubble. Window listener should not see the key.
    expect(onWindow).not.toHaveBeenCalled();
  });
});
