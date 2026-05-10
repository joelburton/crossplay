/**
 * Wire and render type for the header feedback bar.
 *
 * `level` selects the bar's color (info = blue, warning = amber,
 * celebration = green; the last is currently reserved for a future
 * "puzzle solved!" message). `autoVanishMs` is optional — when set, App
 * starts a one-shot timer that clears the bar after the given delay
 * unless replaced by a newer feedback first. Without it, the bar stays
 * until the user dismisses it (clicking it, hitting × , or any puzzle
 * activity).
 */

export type FeedbackLevel = "info" | "warning" | "celebration";

export type Feedback = {
  id: string;
  text: string;
  level: FeedbackLevel;
  autoVanishMs?: number;
};
