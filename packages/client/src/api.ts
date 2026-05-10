import type { PuzzleState } from "@crossplay/shared";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function uploadPuzzle(file: File): Promise<{ puzzleId: string }> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/puzzles", { method: "POST", body: fd });
  if (!res.ok) throw new HttpError(res.status, `upload failed: ${res.status}`);
  return res.json();
}

export async function fetchPuzzle(id: string): Promise<PuzzleState> {
  const res = await fetch(`/api/puzzles/${id}`);
  if (!res.ok) throw new HttpError(res.status, `fetch failed: ${res.status}`);
  return res.json();
}
