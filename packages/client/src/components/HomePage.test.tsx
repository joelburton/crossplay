// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomePage } from "./HomePage";
import * as api from "../api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  // Reset URL so navigate() doesn't carry routes between tests.
  window.history.replaceState({}, "", "/");
});

function stubLists(
  puzzles: api.PuzzleSummary[],
  boards: api.BoardSummary[],
): { fetchPuzzles: ReturnType<typeof vi.fn>; fetchBoards: ReturnType<typeof vi.fn> } {
  const fetchPuzzles = vi.fn().mockResolvedValue(puzzles);
  const fetchBoards = vi.fn().mockResolvedValue(boards);
  vi.spyOn(api, "fetchPuzzles").mockImplementation(fetchPuzzles);
  vi.spyOn(api, "fetchBoards").mockImplementation(fetchBoards);
  return { fetchPuzzles, fetchBoards };
}

function puzzle(id: string, title = id): api.PuzzleSummary {
  return { id, title, author: "Test", copyright: "", width: 5, height: 5 };
}

function board(id: string, title = id): api.BoardSummary {
  return {
    id,
    puzzleId: null,
    title,
    author: "Test",
    copyright: "",
    updatedAt: "2026-05-10T00:00:00Z",
  };
}

/** Wait for any pending promise microtasks resolved by the load
 *  effect's .then handlers to flush — keeps tests free of arbitrary
 *  timeouts. */
async function flushPromises() {
  // Two ticks to cover the .then(setX) -> setState -> re-render path.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("HomePage", () => {
  it("hides the community section when the puzzles list is empty", async () => {
    stubLists([], []);
    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();
    expect(screen.queryByText("Community puzzles")).toBeNull();
    // Your games always shows, with empty-state copy.
    expect(screen.getByText("Your games")).toBeTruthy();
    expect(screen.getByText(/no games yet/i)).toBeTruthy();
  });

  it("shows the community section and a populated games list", async () => {
    stubLists([puzzle("p1", "First")], [board("b1", "MyBoard")]);
    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();
    expect(screen.getByText("Community puzzles")).toBeTruthy();
    expect(screen.getByText("First")).toBeTruthy();
    expect(screen.getByText("MyBoard")).toBeTruthy();
  });

  it("two-step delete: × shows Delete?, confirm calls deleteBoard and removes the row", async () => {
    stubLists([], [board("b1", "Doomed")]);
    const del = vi.spyOn(api, "deleteBoard").mockResolvedValue(undefined);
    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();

    // Initial state: × icon only.
    const trash = screen.getByLabelText("Delete Doomed");
    expect(screen.queryByLabelText("Confirm delete Doomed")).toBeNull();
    fireEvent.click(trash);

    // After the first click: confirm button appears.
    const confirm = screen.getByLabelText("Confirm delete Doomed");
    expect(confirm).toBeTruthy();
    fireEvent.click(confirm);
    await flushPromises();

    expect(del).toHaveBeenCalledExactlyOnceWith("b1");
    // Row is gone — board title no longer rendered.
    expect(screen.queryByText("Doomed")).toBeNull();
  });

  it("Esc dismisses the delete confirm without calling deleteBoard", async () => {
    stubLists([], [board("b1", "Survives")]);
    const del = vi.spyOn(api, "deleteBoard").mockResolvedValue(undefined);
    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();

    fireEvent.click(screen.getByLabelText("Delete Survives"));
    expect(screen.getByLabelText("Confirm delete Survives")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    // Back to the × state.
    expect(screen.queryByLabelText("Confirm delete Survives")).toBeNull();
    expect(screen.getByLabelText("Delete Survives")).toBeTruthy();
    expect(del).not.toHaveBeenCalled();
  });

  it("mousedown outside the confirm button dismisses it", async () => {
    stubLists([], [board("b1", "Survives")]);
    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();

    fireEvent.click(screen.getByLabelText("Delete Survives"));
    expect(screen.getByLabelText("Confirm delete Survives")).toBeTruthy();

    // mousedown on the document body (not the confirm button).
    fireEvent.mouseDown(document.body);
    expect(screen.queryByLabelText("Confirm delete Survives")).toBeNull();
  });

  it("hides the row while DELETE is in flight (no navigate-to-vanishing-board)", async () => {
    stubLists([], [board("b1", "InFlight")]);
    // Slow delete: leave the promise pending so we can inspect the
    // intermediate state.
    let resolveDel: () => void;
    const delPromise = new Promise<void>((r) => {
      resolveDel = r;
    });
    vi.spyOn(api, "deleteBoard").mockReturnValue(delPromise);

    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();

    fireEvent.click(screen.getByLabelText("Delete InFlight"));
    fireEvent.click(screen.getByLabelText("Confirm delete InFlight"));
    await flushPromises();

    // Row is hidden during the in-flight DELETE.
    expect(screen.queryByText("InFlight")).toBeNull();

    // Empty-state copy appears (the only board was hidden).
    expect(screen.getByText(/no games yet/i)).toBeTruthy();

    resolveDel!();
    await flushPromises();
    // Still gone after success.
    expect(screen.queryByText("InFlight")).toBeNull();
  });

  it("refetches and restores the list on delete failure", async () => {
    const initial = [board("b1", "Saved")];
    const stubs = stubLists([], initial);
    vi.spyOn(api, "deleteBoard").mockRejectedValue(new Error("boom"));

    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();

    fireEvent.click(screen.getByLabelText("Delete Saved"));
    fireEvent.click(screen.getByLabelText("Confirm delete Saved"));
    await flushPromises();

    // Second fetch was called to reconcile.
    expect(stubs.fetchBoards).toHaveBeenCalledTimes(2);
    // Row restored once the refetch returns the original list.
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("clicking a community puzzle creates a board then navigates", async () => {
    stubLists([puzzle("p1", "Pick me")], []);
    const create = vi
      .spyOn(api, "createBoard")
      .mockResolvedValue({ boardId: "new-board" });
    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();

    await userEvent.click(screen.getByText("Pick me"));
    await flushPromises();

    expect(create).toHaveBeenCalledExactlyOnceWith("p1");
    expect(window.location.pathname).toBe("/b/new-board");
  });

  it("shows a load-error banner when either fetch fails", async () => {
    vi.spyOn(api, "fetchPuzzles").mockRejectedValue(new Error("nope"));
    vi.spyOn(api, "fetchBoards").mockResolvedValue([]);
    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();
    expect(screen.getByText(/couldn't reach the server/i)).toBeTruthy();
  });
});
