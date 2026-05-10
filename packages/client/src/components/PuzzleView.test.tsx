// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cell, PuzzleState } from "@crossplay/shared";
import { PuzzleView } from "./PuzzleView";

type Listener = (e: any) => void;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = FakeWebSocket.CONNECTING;
  OPEN = FakeWebSocket.OPEN;
  listeners: Record<string, Listener[]> = {};
  sent: unknown[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(name: string, fn: Listener) {
    (this.listeners[name] ??= []).push(fn);
  }
  removeEventListener(name: string, fn: Listener) {
    this.listeners[name] = (this.listeners[name] ?? []).filter((f) => f !== fn);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.fire("close", {});
  }
  fire(name: string, e: any) {
    for (const fn of [...(this.listeners[name] ?? [])]) fn(e);
  }
  emitOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.fire("open", {});
  }
}

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function mediaQueryStub(): MediaQueryList {
  // Wide-viewport: the narrow path is exercised separately by Board's own
  // hook tests if/when added.
  return {
    matches: false,
    media: "",
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
}

function cell(number: number | null, fill: string | null = null): Cell {
  const c: Cell = { kind: "cell", number, fill };
  return c;
}

function makePuzzle(): PuzzleState {
  // 3x3 grid, all open cells.  Numbering matches a real crossword:
  //   1 2 3
  //   4 . .
  //   5 . .
  // (Down clues live at row=0; across clues at the start of each row.)
  const cells: Cell[][] = [
    [cell(1), cell(2), cell(3)],
    [cell(4), cell(null), cell(null)],
    [cell(5), cell(null), cell(null)],
  ];
  return {
    meta: {
      id: "test",
      title: "Test",
      author: "Tester",
      copyright: "",
      note: "",
      width: 3,
      height: 3,
      clues: {
        across: [
          { number: 1, text: "row 1" },
          { number: 4, text: "row 2" },
          { number: 5, text: "row 3" },
        ],
        down: [
          { number: 1, text: "col 1" },
          { number: 2, text: "col 2" },
          { number: 3, text: "col 3" },
        ],
      },
    },
    snapshot: {
      version: 0,
      cells,
    },
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver as unknown as typeof ResizeObserver);
  vi.stubGlobal("matchMedia", ((_q: string) => mediaQueryStub()) as typeof window.matchMedia);
  // matchMedia must also live on `window` in jsdom.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (_q: string) => mediaQueryStub(),
  });
  // jsdom doesn't implement scrollIntoView; ClueList calls it on every
  // active-clue change.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
  // Ensure readChatIdentity is deterministic.
  window.history.replaceState({}, "", "/?name=Tester");
  window.localStorage?.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PuzzleView happy path", () => {
  it("optimistically fills the cursor cell and sends a fill message on letter key", () => {
    render(
      <PuzzleView
        puzzle={makePuzzle()}
        mode="pen"
        onToggleMode={() => {}}
      />,
    );

    // Connection established; firstOpenCell put the cursor at (0,0).
    const ws = FakeWebSocket.instances[0]!;
    expect(ws).toBeTruthy();
    act(() => ws.emitOpen());

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    });

    // Optimistic local fill — the cell at (0,0) now shows "A".
    expect(screen.getByText("A")).toBeTruthy();

    // And a `fill` message was emitted with the upper-cased letter.
    const fills = ws.sent.filter(
      (m): m is { type: "fill"; row: number; col: number; letter: string; clientVersion: number; pencil?: boolean } =>
        (m as { type: string }).type === "fill",
    );
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      type: "fill",
      row: 0,
      col: 0,
      letter: "A",
      clientVersion: 0,
    });
    // pencil flag is omitted in pen mode.
    expect(fills[0]!.pencil).toBeUndefined();
  });

  it("sends pencil:true when mode is pencil", () => {
    render(
      <PuzzleView
        puzzle={makePuzzle()}
        mode="pencil"
        onToggleMode={() => {}}
      />,
    );
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.emitOpen());
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
    });
    const fills = ws.sent.filter(
      (m): m is { type: "fill"; letter: string; pencil?: boolean } =>
        (m as { type: string }).type === "fill",
    );
    expect(fills).toHaveLength(1);
    expect(fills[0]!.letter).toBe("B");
    expect(fills[0]!.pencil).toBe(true);
  });

  it("ignores letter keys when an input/textarea has focus", () => {
    render(
      <PuzzleView
        puzzle={makePuzzle()}
        mode="pen"
        onToggleMode={() => {}}
      />,
    );
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.emitOpen());

    // Drop a textarea into the document and focus it.
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();

    act(() => {
      // Dispatch from the textarea so e.target.tagName === 'TEXTAREA'.
      ta.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true }),
      );
    });

    const fills = ws.sent.filter((m) => (m as { type: string }).type === "fill");
    expect(fills).toEqual([]);
    document.body.removeChild(ta);
  });
});
