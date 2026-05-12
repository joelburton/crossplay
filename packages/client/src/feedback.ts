import type { ReactNode } from "react";

/**
 * Render type for the header feedback bar.
 *
 * `level` selects the bar's color (info = blue, warning = amber,
 * celebration = green; the last is currently reserved for a future
 * "puzzle solved!" message). `autoVanishMs` is optional — when set, App
 * starts a one-shot timer that clears the bar after the given delay
 * unless replaced by a newer feedback first. Without it, the bar stays
 * until the user dismisses it (clicking it, hitting × , or any puzzle
 * activity).
 *
 * `text` is a `ReactNode` rather than a plain string so client-emitted
 * feedback (welcome, no-notes) can use light inline markup — e.g. a
 * styled heart in the welcome message. The wire still carries strings
 * (see `ServerMessage` in `@crossplay/shared`); a string is a valid
 * `ReactNode`, so the assignment is implicit when the WS handler
 * builds the Feedback object. Prefer ReactNode over HTML-via-
 * `dangerouslySetInnerHTML`: same expressiveness, but no XSS surface
 * if a future code path ever routes untrusted input into feedback.
 */

export type FeedbackLevel = "info" | "warning" | "celebration";

export type Feedback = {
  id: string;
  text: ReactNode;
  level: FeedbackLevel;
  autoVanishMs?: number;
};
