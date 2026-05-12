// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareDialog } from "./ShareDialog";
import * as api from "../api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ShareDialog", () => {
  it("submits a handle, calls shareBoard, and shows the canonical handle in the success line", async () => {
    const share = vi
      .spyOn(api, "shareBoard")
      .mockResolvedValue({ handle: "Moth", alreadyMember: false });
    render(<ShareDialog boardId="b1" onClose={() => {}} />);
    const input = screen.getByLabelText("Handle") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "moth" } });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await flushPromises();
    expect(share).toHaveBeenCalledExactlyOnceWith("b1", "moth");
    expect(screen.getByText(/Shared with:/)).toBeTruthy();
    expect(screen.getByText(/Moth/)).toBeTruthy();
    // Input clears so the next handle can be typed immediately.
    expect(input.value).toBe("");
  });

  it("accumulates multiple shares in one session", async () => {
    vi.spyOn(api, "shareBoard")
      .mockResolvedValueOnce({ handle: "Moth", alreadyMember: false })
      .mockResolvedValueOnce({ handle: "Sue", alreadyMember: false });
    render(<ShareDialog boardId="b1" onClose={() => {}} />);
    const input = screen.getByLabelText("Handle") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "moth" } });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await flushPromises();
    fireEvent.change(input, { target: { value: "sue" } });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await flushPromises();
    expect(screen.getByText(/Moth.*Sue|Sue.*Moth/)).toBeTruthy();
  });

  it("marks an already-member share with the soft '(already a member)' note", async () => {
    vi.spyOn(api, "shareBoard").mockResolvedValue({
      handle: "Moth",
      alreadyMember: true,
    });
    render(<ShareDialog boardId="b1" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Handle"), { target: { value: "moth" } });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await flushPromises();
    expect(screen.getByText(/Moth \(already a member\)/)).toBeTruthy();
  });

  it("surfaces the server's error message on failure", async () => {
    vi.spyOn(api, "shareBoard").mockRejectedValue(
      new api.HttpError(404, "No user with that handle."),
    );
    render(<ShareDialog boardId="b1" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Handle"), { target: { value: "ghost" } });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await flushPromises();
    expect(screen.getByText("No user with that handle.")).toBeTruthy();
  });

  it("Esc closes the dialog without calling shareBoard", async () => {
    const share = vi.spyOn(api, "shareBoard");
    const onClose = vi.fn();
    render(<ShareDialog boardId="b1" onClose={onClose} />);
    fireEvent.keyDown(screen.getByLabelText("Handle"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(share).not.toHaveBeenCalled();
  });

  it("Share button is disabled when the input is empty", () => {
    render(<ShareDialog boardId="b1" onClose={() => {}} />);
    const btn = screen.getByRole("button", { name: "Share" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Handle"), { target: { value: "moth" } });
    expect(btn.disabled).toBe(false);
  });
});
