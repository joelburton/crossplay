// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserMenu } from "./UserMenu";

afterEach(() => {
  cleanup();
});

describe("UserMenu", () => {
  it("renders the handle and is closed by default", () => {
    render(<UserMenu handle="Moth" onLogout={() => {}} hasNytCookie={false} onNytCookieChanged={() => {}} prefs={{}} onPrefsChanged={() => {}} />);
    expect(screen.getByText("Moth")).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Log out" })).toBeNull();
  });

  it("opens on trigger click and shows Log out", () => {
    render(<UserMenu handle="Moth" onLogout={() => {}} hasNytCookie={false} onNytCookieChanged={() => {}} prefs={{}} onPrefsChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Moth/ }));
    expect(screen.getByRole("menuitem", { name: "Log out" })).toBeTruthy();
  });

  it("calls onLogout when the menu item is activated", () => {
    const onLogout = vi.fn();
    render(<UserMenu handle="Moth" onLogout={onLogout} hasNytCookie={false} onNytCookieChanged={() => {}} prefs={{}} onPrefsChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Moth/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Log out" }));
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it("closes on Escape", () => {
    render(<UserMenu handle="Moth" onLogout={() => {}} hasNytCookie={false} onNytCookieChanged={() => {}} prefs={{}} onPrefsChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Moth/ }));
    expect(screen.getByRole("menuitem", { name: "Log out" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menuitem", { name: "Log out" })).toBeNull();
  });

  it("closes on pointerdown outside the menu", () => {
    render(
      <>
        <button type="button" data-testid="outside">outside</button>
        <UserMenu handle="Moth" onLogout={() => {}} hasNytCookie={false} onNytCookieChanged={() => {}} prefs={{}} onPrefsChanged={() => {}} />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Moth/ }));
    expect(screen.getByRole("menuitem", { name: "Log out" })).toBeTruthy();
    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(screen.queryByRole("menuitem", { name: "Log out" })).toBeNull();
  });
});
