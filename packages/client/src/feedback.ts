export type FeedbackLevel = "info" | "warning" | "celebration";

export type Feedback = {
  id: string;
  text: string;
  level: FeedbackLevel;
  autoVanishMs?: number;
};
