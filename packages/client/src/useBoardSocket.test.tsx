// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBoardSocket } from "./useBoardSocket";

type Listener = (e: any) => void;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = FakeWebSocket.CONNECTING;
  // Instance copy — useBoardSocket compares `ws.readyState === ws.OPEN`.
  OPEN = FakeWebSocket.OPEN;
  listeners: Record<string, Listener[]> = {};
  sent: string[] = [];
  closeCalled = 0;

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
    this.sent.push(data);
  }

  close() {
    this.closeCalled += 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.fire("close", {});
  }

  // Helpers used by tests:
  fire(name: string, e: any) {
    for (const fn of [...(this.listeners[name] ?? [])]) fn(e);
  }
  emitOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.fire("open", {});
  }
  emitMessage(payload: unknown) {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.fire("message", { data });
  }
  emitClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.fire("close", {});
  }
}

function makeHandlers() {
  return {
    onSnapshot: vi.fn(),
    onCellUpdate: vi.fn(),
    onChatMessage: vi.fn(),
    onNotesShown: vi.fn(),
    onFeedback: vi.fn(),
    onOpen: vi.fn(),
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useBoardSocket", () => {
  it("opens a WebSocket to /ws/boards/<id> on mount", () => {
    renderHook(() => useBoardSocket("abc", makeHandlers()));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.url).toMatch(/\/ws\/boards\/abc$/);
  });

  it("reports state transitions and fires onOpen", () => {
    const handlers = makeHandlers();
    const { result } = renderHook(() => useBoardSocket("p1", handlers));
    expect(result.current.state).toBe("connecting");
    act(() => FakeWebSocket.instances[0]!.emitOpen());
    expect(result.current.state).toBe("open");
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
  });

  it("dispatches snapshot, cellUpdate, chatMessage, notesShown, and feedback", () => {
    const handlers = makeHandlers();
    renderHook(() => useBoardSocket("p1", handlers));
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.emitOpen());

    const snapshot = { version: 1, cells: [] };
    act(() => ws.emitMessage({ type: "snapshot", snapshot }));
    expect(handlers.onSnapshot).toHaveBeenCalledWith(snapshot);

    const cell = { kind: "cell", number: null, fill: "A" };
    act(() =>
      ws.emitMessage({
        type: "cellUpdate",
        row: 1,
        col: 2,
        cell,
        version: 7,
        senderColor: "#abc",
      }),
    );
    expect(handlers.onCellUpdate).toHaveBeenCalledWith(1, 2, cell, 7, "#abc");

    act(() =>
      ws.emitMessage({
        type: "chatMessage",
        name: "Alice",
        color: "#f00",
        text: "hi",
        ts: 123,
      }),
    );
    expect(handlers.onChatMessage).toHaveBeenCalledWith({
      name: "Alice",
      color: "#f00",
      text: "hi",
      ts: 123,
    });

    act(() => ws.emitMessage({ type: "notesShown" }));
    expect(handlers.onNotesShown).toHaveBeenCalledTimes(1);

    act(() =>
      ws.emitMessage({
        type: "feedback",
        id: "x",
        text: "joined",
        level: "info",
        autoVanishMs: 2000,
      }),
    );
    expect(handlers.onFeedback).toHaveBeenCalledWith({
      id: "x",
      text: "joined",
      level: "info",
      autoVanishMs: 2000,
    });
  });

  it("ignores malformed JSON messages instead of throwing", () => {
    const handlers = makeHandlers();
    renderHook(() => useBoardSocket("p1", handlers));
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.emitOpen());
    expect(() => act(() => ws.emitMessage("not json{"))).not.toThrow();
    expect(handlers.onSnapshot).not.toHaveBeenCalled();
  });

  it("reads handlers from a ref — stale closures get the latest callback", () => {
    const first = makeHandlers();
    const second = makeHandlers();
    const { rerender } = renderHook(({ h }) => useBoardSocket("p1", h), {
      initialProps: { h: first },
    });
    rerender({ h: second });
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.emitOpen());
    act(() => ws.emitMessage({ type: "snapshot", snapshot: { version: 0, cells: [] } }));
    expect(first.onSnapshot).not.toHaveBeenCalled();
    expect(second.onSnapshot).toHaveBeenCalledTimes(1);
  });

  it("reconnects with exponential backoff after close, resetting on success", () => {
    const handlers = makeHandlers();
    const { result } = renderHook(() => useBoardSocket("p1", handlers));
    const first = FakeWebSocket.instances[0]!;
    act(() => first.emitOpen());

    // First disconnect → 500ms delay before reconnect attempt.
    act(() => first.emitClose());
    expect(result.current.state).toBe("closed");
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(499));
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeWebSocket.instances).toHaveLength(2);

    const second = FakeWebSocket.instances[1]!;
    // Without a successful open in between, the next close uses the next
    // step in the backoff (1000ms).
    act(() => second.emitClose());
    act(() => vi.advanceTimersByTime(999));
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeWebSocket.instances).toHaveLength(3);

    // A successful open resets the attempt counter — next close goes
    // back to 500ms.
    const third = FakeWebSocket.instances[2]!;
    act(() => third.emitOpen());
    act(() => third.emitClose());
    act(() => vi.advanceTimersByTime(499));
    expect(FakeWebSocket.instances).toHaveLength(3);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("send() writes when OPEN and silently drops otherwise", () => {
    const { result } = renderHook(() => useBoardSocket("p1", makeHandlers()));
    const ws = FakeWebSocket.instances[0]!;

    // Not yet open: drop.
    act(() => result.current.send({ type: "clear" }));
    expect(ws.sent).toEqual([]);

    act(() => ws.emitOpen());
    act(() => result.current.send({ type: "clear" }));
    expect(ws.sent).toEqual([JSON.stringify({ type: "clear" })]);
  });

  it("closes the socket on unmount and stops reconnect attempts", () => {
    const { unmount } = renderHook(() => useBoardSocket("p1", makeHandlers()));
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.emitOpen());
    unmount();
    expect(ws.closeCalled).toBeGreaterThan(0);
    // Even after the backoff window elapses, no new socket should be created.
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
