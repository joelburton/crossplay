// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Cell, PuzzleState } from "@crossplay/shared";
import { PrintPage } from "./PrintPage";
import * as api from "../api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function cell(number: number | null, fill: string | null = null): Cell {
  return { kind: "cell", number, fill };
}

function makePuzzle(): PuzzleState {
  const cells: Cell[][] = [
    [cell(1), cell(2), cell(3)],
    [cell(4), cell(null), cell(null)],
    [cell(5), cell(null), cell(null)],
  ];
  return {
    meta: {
      id: "b1",
      title: "Print Test",
      author: "Tester",
      copyright: "© 2026",
      note: "",
      width: 3,
      height: 3,
      clues: {
        across: [{ number: 1, text: "first across" }],
        down: [{ number: 1, text: "first down" }],
      },
    },
    snapshot: { version: 0, cells },
  };
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("PrintPage", () => {
  it("fetches the board and renders the title + a Generate PDF button", async () => {
    vi.spyOn(api, "fetchBoard").mockResolvedValue(makePuzzle());
    render(<PrintPage boardId="b1" />);
    await flushPromises();

    expect(screen.getByText("Print Test")).toBeTruthy();
    expect(screen.getByRole("button", { name: /generate pdf/i })).toBeTruthy();
  });

  it("surfaces a friendly message on 404", async () => {
    vi.spyOn(api, "fetchBoard").mockRejectedValue(new api.HttpError(404, "fetch failed: 404"));
    render(<PrintPage boardId="missing" />);
    await flushPromises();

    expect(screen.getByText("Board not found.")).toBeTruthy();
  });

  it("sets the document title", async () => {
    vi.spyOn(api, "fetchBoard").mockResolvedValue(makePuzzle());
    render(<PrintPage boardId="b1" />);
    await flushPromises();

    expect(document.title).toBe("Print Test — Crossplay");
  });
});
