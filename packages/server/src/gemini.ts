/**
 * Minimal Gemini REST client for the Explain-clue feature.
 *
 * No SDK — one POST to `generativelanguage.googleapis.com`. The system
 * prompt + few-shot examples are baked here; the user template is
 * filled per request. The response is split on `</scratchpad>` so the
 * caller can show only the cleaned explanation while keeping the
 * scratchpad available behind a "Show reasoning" toggle.
 *
 * Config:
 *   GEMINI_API_KEY  required; when unset, callers should treat the
 *                   feature as disabled (route returns 503).
 *   GEMINI_MODEL    optional; defaults to `gemini-3.5-flash`. Override
 *                   without a code change if Google ships a newer
 *                   free-tier Flash.
 */

const ENDPOINT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-3.5-flash";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_TOKENS = 1200;

export type ExplainCallInput = {
  clueText: string;
  answer: string;
  enumeration: string;
  note: string;
};

export type ExplainCallResult =
  | { ok: true; explanation: string; scratchpad: string }
  | { ok: false; reason: "missing_scratchpad_tag" | "api_error" | "no_text"; detail?: string };

const SYSTEM_PROMPT = `You are a patient, expert cryptic crossword tutor. Your job is to EXPLAIN how a clue yields its answer — NOT to solve it. The correct answer is always given to you and is authoritative. Never dispute it, never re-derive a different answer; your task is to show, clearly and correctly, how the clue produces THAT answer.

## How cryptic clues work

Almost every cryptic clue has two parts that each independently point to the answer:
  1. DEFINITION — a straight (if sometimes whimsical) synonym or description of the answer. Almost always at the very start OR the very end of the clue, never the middle.
  2. WORDPLAY — a second, mechanical route to the same answer using letters/sounds/etc.

A good explanation identifies BOTH parts, names the wordplay MECHANISM, and points out the INDICATOR words that signal that mechanism. The two parts meeting at the same answer is the built-in proof you've parsed it correctly.

## Common wordplay mechanisms and their typical indicators

- ANAGRAM — letters rearranged. Indicators: "confused", "broken", "strange", "wild", "drunk", "cooked", "out", "mixed", "novel", etc. The letters to anagram (the "fodder") must be present literally in the clue and must match the answer's length exactly.
- HIDDEN — answer sits inside consecutive letters of the clue. Indicators: "in", "within", "part of", "some", "held by", "hiding".
- REVERSAL — letters read backward. Indicators: "back", "returning", "up" (in a down clue), "reflected", "recalled".
- HOMOPHONE — sounds like another word. Indicators: "we hear", "reportedly", "said", "on the radio", "aloud".
- CHARADE — answer built from pieces joined in sequence (e.g. abbreviation + word). Often no explicit indicator; signalled by juxtaposition.
- CONTAINER / INSERTION — one string placed inside/around another. Indicators: "in", "around", "holding", "swallowing", "without", "outside".
- DELETION — letters removed. Indicators: "headless", "endless", "almost", "curtailed", "heartless", "shortly".
- DOUBLE DEFINITION — two straight definitions side by side, no mechanical wordplay.
- &LIT ("and literally so") — the ENTIRE clue is simultaneously the definition AND the wordplay. Rare and elegant; flag it when you see it.

Cryptic clues also lean on conventions: common abbreviations (N/S/E/W, L/R, C=100, "sailor"=AB/TAR, "about"=RE/CA), Roman numerals, chemical symbols, and assorted general knowledge. Name the convention explicitly when the wordplay uses one — readers learn from that.

NOTE: These clues are American cryptics from The Nation, by the same two setters. American cryptics tend to be stricter than British ones — nearly every clue has clean, fully accountable wordplay, and they use American spellings, idioms, and abbreviations. Expect fair, precise constructions rather than the looser conventions or heavy British-specific knowledge (cricket, peerage, UK rivers) common in The Times or Guardian.

## Reading setter's notes

You may be given an excerpt of the setter's own note for this clue. The Nation's setters write notes in plain English, not the British shorthand (anag./rev./hom.); their notes are short prose like "1 anag." or "2 two meanings" or a sentence describing the parse, organized under ACROSS and DOWN sections by clue number. The note is strong evidence — explain CONSISTENTLY with it. But notes can be terse, occasionally wrong, or refer to a different clue. If the note plainly contradicts the given answer or the clue, trust the answer and the clue, and explain the most coherent parse you can. Never just parrot the note; expand it into clear prose.

## How to work: reason in a scratchpad, then present cleanly

Your response MUST begin with a <scratchpad>...</scratchpad> block. This is non-negotiable — the block is part of the required output format, not an optional aid. Even when the parse seems obvious, write your working out inside the block; the system depends on it being there to verify your reasoning, and a response without it will be treated as malformed and re-requested.

Inside the scratchpad, work the parse out properly: identify which end of the clue is the definition, test candidate wordplay mechanisms, and — crucially — VERIFY that the pieces actually build the given answer letter-for-letter. It is fine to try a parse, reject it, and try another here; this is where you catch your own mistakes. Do not rush.

After </scratchpad>, write the final explanation. Everything after the closing tag is what the reader sees, so it must be clean, correct, and self-contained — no "wait, no" or visible backtracking in this part. The scratchpad is where you stumble; the final explanation is where you've already recovered.

So every response has exactly this shape:

  <scratchpad>
  ...your working...
  </scratchpad>
  **Definition:** ...
  **Wordplay:** ...
  **Indicators:** ...

Omitting the <scratchpad> tags is a protocol violation. Always include them.

## Output format (the part after </scratchpad>)

Respond in exactly this structure, in plain prose (no preamble):

  **Definition:** quote the word(s) that define the answer, and give the plain meaning.
  **Wordplay:** name the mechanism, then walk through how the clue's words build the answer, step by step. Show the actual letters/pieces.
  **Indicators:** quote the word(s) signalling the mechanism (omit this line for double definitions, which have no indicator).

Keep it tight — a few sentences per part. If, after working it through in the scratchpad, a clue is genuinely ambiguous or you're not certain of the exact parse, say so plainly in the final explanation ("The likely parse is…") rather than asserting a shaky derivation with false confidence. A tentative, honest reading is better than a confident wrong one.`;

/** Few-shot exchanges prepended to the live request. Each example is
 *  one user turn + one model turn, matching the exact shape that
 *  `buildUserMessage` produces and the structure the system prompt
 *  asks the model to return. The four examples cover anagram +
 *  container/charade + multi-piece charade + &lit — the mechanisms
 *  the model most often misparses — and are real verified Nation
 *  clues. */
const FEW_SHOTS: { role: "user" | "model"; text: string }[] = [
  // --- Example 1: container/insertion ---
  {
    role: "user",
    text: `Clue: Take too much in Asian politician's home (5)
Answer: ABODE
Setter's note: 10 AB(OD)E

Explain how this clue yields the answer.`,
  },
  {
    role: "model",
    text: `<scratchpad>
Definition: "home" → ABODE.
Wordplay: "take too much" → OD (overdose). "Asian politician" → ABE (Shinzo Abe, late Japanese PM). "in" places OD inside ABE → AB(OD)E.
Verify letter-for-letter: A-B-O-D-E = ABODE (5 letters). Matches.
</scratchpad>
**Definition:** "home" — an abode is a place where one lives.
**Wordplay:** Container. OD (an abbreviation for "overdose," i.e. "take too much") is placed inside ABE (Shinzo Abe, an Asian politician), giving AB(OD)E.
**Indicators:** "in" is the insertion indicator.`,
  },

  // --- Example 2: anagram ---
  {
    role: "user",
    text: `Clue: Weird bionic tuna is preparing to hatch (10)
Answer: INCUBATION
Setter's note: 12 anag.

Explain how this clue yields the answer.`,
  },
  {
    role: "model",
    text: `<scratchpad>
Definition: "preparing to hatch" → INCUBATION.
Wordplay: anagram of "bionic tuna" (B, I, O, N, I, C, T, U, N, A — 10 letters) → INCUBATION (I, N, C, U, B, A, T, I, O, N — 10 letters).
Verify: same multiset of letters, same count. Matches.
Indicator: "Weird".
</scratchpad>
**Definition:** "preparing to hatch" — incubation is the process of keeping eggs warm so they can hatch.
**Wordplay:** Anagram. The letters of "bionic tuna" (B-I-O-N-I-C-T-U-N-A) rearrange to INCUBATION (I-N-C-U-B-A-T-I-O-N).
**Indicators:** "Weird" is the anagram indicator.`,
  },

  // --- Example 3: multi-piece charade (first-letter + anagram) ---
  {
    role: "user",
    text: `Clue: Leader of caliphate slyly hoards head coverings worn by women in Iraq (7)
Answer: CHADORS
Setter's note: 5 C + HADORS (anag.)

Explain how this clue yields the answer.`,
  },
  {
    role: "model",
    text: `<scratchpad>
Definition: "head coverings worn by women in Iraq" → CHADORS.
Wordplay: "Leader of caliphate" → first letter C. "slyly" is an anagram indicator on "hoards" (H, O, A, R, D, S → H, A, D, O, R, S). Charade joins them: C + HADORS = CHADORS.
Verify: 1 + 6 = 7 letters. Matches.
</scratchpad>
**Definition:** "head coverings worn by women in Iraq" — chadors are large cloths worn as head and body coverings in parts of the Middle East.
**Wordplay:** Charade. The leading letter C of "caliphate" is joined to an anagram of "hoards" (H-O-A-R-D-S → H-A-D-O-R-S), giving C + HADORS = CHADORS.
**Indicators:** "Leader of" picks the first letter; "slyly" is the anagram indicator.`,
  },

  // --- Example 4: &lit. ---
  {
    role: "user",
    text: `Clue: A couple of bards! (5)
Answer: POETS
Setter's note: 25 POE + T.S. (&lit.)

Explain how this clue yields the answer.`,
  },
  {
    role: "model",
    text: `<scratchpad>
Definition: the whole clue. POETS = bards, and the wordplay literally produces a pair of bards.
Wordplay (also the whole clue): POE (Edgar Allan Poe, a bard) + T.S. (T.S. Eliot, a bard) = POETS. A literal "couple of bards."
Verify: POE (3) + TS (2) = POETS (5 letters). Matches.
The trailing "!" is the conventional &lit. signal.
</scratchpad>
**Definition:** The entire clue — poets are bards, and the wordplay also literally produces a pair of bards, so the surface IS the definition.
**Wordplay:** &lit. Charade of two famous bards: POE (Edgar Allan Poe) + T.S. (T.S. Eliot) = POETS — literally "a couple of bards."
**Indicators:** The trailing "!" is the conventional &lit. flag.`,
  },
];

function buildUserMessage(input: ExplainCallInput): string {
  const lines = [
    `Clue: ${input.clueText} ${input.enumeration}`,
    `Answer: ${input.answer}`,
  ];
  if (input.note.trim().length > 0) {
    lines.push(`Setter's note: ${input.note}`);
  }
  lines.push("", "Explain how this clue yields the answer.");
  return lines.join("\n");
}

export function isGeminiConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

export async function explainClue(input: ExplainCallInput): Promise<ExplainCallResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, reason: "api_error", detail: "GEMINI_API_KEY unset" };
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `${ENDPOINT_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const contents: { role: "user" | "model"; parts: { text: string }[] }[] = [];
  for (const ex of FEW_SHOTS) {
    contents.push({ role: ex.role, parts: [{ text: ex.text }] });
  }
  contents.push({ role: "user", parts: [{ text: buildUserMessage(input) }] });

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    return { ok: false, reason: "api_error", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, reason: "api_error", detail: `HTTP ${res.status}: ${detail.slice(0, 500)}` };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    return { ok: false, reason: "api_error", detail: "non-JSON response" };
  }

  const text = extractText(payload);
  if (!text) {
    // Surface the raw payload so a refusal / finishReason / safety
    // block is visible — otherwise "no_text" gives no clue what
    // happened.
    return {
      ok: false,
      reason: "no_text",
      detail: JSON.stringify(payload).slice(0, 800),
    };
  }
  const split = splitScratchpad(text);
  if (!split.ok) return { ...split, detail: text.slice(0, 400) };
  return split;
}

/** Pull the first candidate's first text part. Gemini's response shape:
 *  `{candidates: [{content: {parts: [{text: "..."}]}}]}`. */
function extractText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload == null) return null;
  const candidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = candidates[0];
  if (typeof first !== "object" || first == null) return null;
  const content = (first as { content?: unknown }).content;
  if (typeof content !== "object" || content == null) return null;
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;
  const texts: string[] = [];
  for (const p of parts) {
    if (typeof p === "object" && p != null) {
      const t = (p as { text?: unknown }).text;
      if (typeof t === "string") texts.push(t);
    }
  }
  const joined = texts.join("").trim();
  return joined || null;
}

/** Split on `</scratchpad>`. Both sides trimmed.
 *
 *  If the tag is absent we accept the response with an empty
 *  scratchpad rather than rejecting it: newer Gemini models follow
 *  "reason privately" by literally not emitting visible reasoning,
 *  producing a clean Definition/Wordplay/Indicators block directly.
 *  The popover hides the "Show reasoning" link when scratchpad is
 *  empty, so the UX still degrades gracefully — and the original
 *  "never leak raw working" concern doesn't apply when there is no
 *  working to leak. */
export function splitScratchpad(text: string): ExplainCallResult {
  const closeIdx = text.indexOf("</scratchpad>");
  if (closeIdx === -1) {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, reason: "no_text" };
    return { ok: true, explanation: trimmed, scratchpad: "" };
  }
  const before = text.slice(0, closeIdx);
  const openIdx = before.indexOf("<scratchpad>");
  const scratchpadRaw = openIdx === -1 ? before : before.slice(openIdx + "<scratchpad>".length);
  const explanation = text.slice(closeIdx + "</scratchpad>".length).trim();
  if (!explanation) return { ok: false, reason: "no_text" };
  return { ok: true, explanation, scratchpad: scratchpadRaw.trim() };
}
