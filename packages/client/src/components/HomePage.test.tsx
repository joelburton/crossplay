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

function board(
  id: string,
  title = id,
  overrides: Partial<api.BoardSummary> = {},
): api.BoardSummary {
  return {
    id,
    puzzleId: null,
    title,
    author: "Test",
    copyright: "",
    updatedAt: "2026-05-10T00:00:00Z",
    fillPercent: null,
    ...overrides,
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
  it("hides the puzzle library section when the puzzles list is empty", async () => {
    stubLists([], []);
    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();
    // Scope to <h2> so we don't false-match the upload hint's italic
    // mention of "Puzzle library".
    expect(screen.queryByRole("heading", { name: "Puzzle library" })).toBeNull();
    // Your games always shows, with empty-state copy. Scope to the
    // heading because the upload hint also mentions "Your games".
    expect(screen.getByRole("heading", { name: "Your games" })).toBeTruthy();
    expect(screen.getByText(/no games yet/i)).toBeTruthy();
  });

  it("shows the puzzle library section and a populated games list", async () => {
    stubLists([puzzle("p1", "First")], [board("b1", "MyBoard")]);
    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();
    expect(screen.getByRole("heading", { name: "Puzzle library" })).toBeTruthy();
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

  it("renders 'NEW' for a board with a null fillPercent", async () => {
    stubLists([], [board("b1", "FreshBoard", { fillPercent: null })]);
    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();
    expect(screen.getByText("NEW")).toBeTruthy();
  });

  it("renders 'N%' for a partially-filled board", async () => {
    stubLists([], [board("b1", "InProgress", { fillPercent: 42 })]);
    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();
    expect(screen.getByText("42%")).toBeTruthy();
  });

  it("renders '100%' for a fully-filled board", async () => {
    stubLists([], [board("b1", "Done", { fillPercent: 100 })]);
    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();
    expect(screen.getByText("100%")).toBeTruthy();
  });

  it("filters the puzzle library by title (case-insensitive substring)", async () => {
    stubLists(
      [puzzle("p1", "Sunday Times"), puzzle("p2", "Monday Mini"), puzzle("p3", "Friday Themeless")],
      [],
    );
    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();

    expect(screen.getByText("Sunday Times")).toBeTruthy();
    expect(screen.getByText("Monday Mini")).toBeTruthy();

    const input = screen.getByLabelText("Filter puzzle library");
    await userEvent.type(input, "mond");
    await flushPromises();

    expect(screen.queryByText("Sunday Times")).toBeNull();
    expect(screen.getByText("Monday Mini")).toBeTruthy();
    expect(screen.queryByText("Friday Themeless")).toBeNull();
  });

  it("filters the puzzle library by copyright (e.g. 'times' → NYT)", async () => {
    stubLists(
      [
        { id: "p1", title: "Sunday", author: "Anon", copyright: "2026, The New York Times", width: 5, height: 5 },
        { id: "p2", title: "Monday", author: "Anon", copyright: "© 2026, Washington Post", width: 5, height: 5 },
      ],
      [],
    );
    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();

    await userEvent.type(screen.getByLabelText("Filter puzzle library"), "times");
    await flushPromises();

    expect(screen.getByText("Sunday")).toBeTruthy();
    expect(screen.queryByText("Monday")).toBeNull();
  });

  it("filters the puzzle library by author too", async () => {
    stubLists(
      [
        { id: "p1", title: "Untitled A", author: "Wagner", copyright: "", width: 5, height: 5 },
        { id: "p2", title: "Untitled B", author: "Birnholz", copyright: "", width: 5, height: 5 },
      ],
      [],
    );
    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();

    const input = screen.getByLabelText("Filter puzzle library");
    await userEvent.type(input, "birn");
    await flushPromises();

    expect(screen.queryByText("Untitled A")).toBeNull();
    expect(screen.getByText("Untitled B")).toBeTruthy();
  });

  it("shows 'no puzzles match' when the puzzle filter has zero hits", async () => {
    stubLists([puzzle("p1", "Sunday")], []);
    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();

    await userEvent.type(screen.getByLabelText("Filter puzzle library"), "xxxx");
    await flushPromises();

    expect(screen.getByText(/no puzzles match/i)).toBeTruthy();
    expect(screen.queryByText("Sunday")).toBeNull();
  });

  it("filters Your games and shows 'no games match' when the filter has zero hits", async () => {
    stubLists(
      [],
      [board("b1", "Alpha"), board("b2", "Beta")],
    );
    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();

    const input = screen.getByLabelText("Filter your games");
    await userEvent.type(input, "alph");
    await flushPromises();
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("Beta")).toBeNull();

    await userEvent.clear(input);
    await userEvent.type(input, "zzz");
    await flushPromises();
    expect(screen.getByText(/no games match/i)).toBeTruthy();
  });

  it("hides the Your-games filter input when the list is empty", async () => {
    stubLists([], []);
    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();
    expect(screen.queryByLabelText("Filter your games")).toBeNull();
    // Original empty-state copy still shows.
    expect(screen.getByText(/no games yet/i)).toBeTruthy();
  });

  it("renders the centered hero (icon + Crossplay wordmark)", async () => {
    stubLists([], []);
    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();
    // The wordmark is an h1 — distinct from the section headings.
    const h1 = screen.getByRole("heading", { level: 1, name: "Crossplay" });
    expect(h1).toBeTruthy();
  });

  it("shows a load-error banner when either fetch fails", async () => {
    vi.spyOn(api, "fetchPuzzles").mockRejectedValue(new Error("nope"));
    vi.spyOn(api, "fetchBoards").mockResolvedValue([]);
    render(<HomePage onUploaded={() => {}} />);
    await flushPromises();
    expect(screen.getByText(/couldn't reach the server/i)).toBeTruthy();
  });
});
