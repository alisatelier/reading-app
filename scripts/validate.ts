// src/validate.ts
export type Role = "past" | "present" | "future";

/** Soft lint list — used for warnings/repairs, NOT hard failures */
export const DISCOURAGED_PHRASES = [
  "be mindful",
  "reflect",
  "moving forward",
  "remember",
  "this is a time",
  "appears to",
  "signify",
  "calling",
  "ready for you to",
  "let the path unfold",
  "now it's time",
  "the card suggests",
  "the card indicates",
  "this card appears",
  "this card signifies",
];

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function sentenceCount(text: string): number {
  const matches = text.trim().match(/[.!?](?=\s|$)/g);
  return matches ? matches.length : 0;
}

export function hasImperativeVerbs(text: string): boolean {
  // soft detection for mid-sentence imperatives
  // (kept conservative to avoid false positives)
  return /\b(speak|take|try|remember|focus|consider|embrace|choose|commit)\b/i.test(text);
}
/** Soft lint: returns phrases detected (case-insensitive). */
export function lintDiscouragedPhrases(text: string): string[] {
  const t = text.toLowerCase();
  return DISCOURAGED_PHRASES.filter((p) => t.includes(p));
}

/** Hard rule: avoid coaching imperatives by sentence starts. */
const DISCOURAGED_IMPERATIVE_STARTS = [
  "take ",
  "try ",
  "remember",
  "focus ",
  "reflect",
  "act ",
  "choose ",
  "commit ",
  "consider ",
  "embrace ",
  "let ",
  "allow ",
];

export function validateNoImperativeCoaching(text: string) {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  for (const s of sentences) {
    for (const start of DISCOURAGED_IMPERATIVE_STARTS) {
      if (s.startsWith(start)) {
        throw new Error(
          `Imperative coaching detected: sentence starts with "${start.trim()}"`
        );
      }
    }
  }
}

export type ValidateOptions = {
  minWords?: number; // default 75
  maxWords?: number; // default 150
  requireSentenceCount?: number; // optional strict sentence count
  enforceNoImperatives?: boolean; // default true
};

export function validateText(text: string, role: Role, opts: ValidateOptions = {}) {
  const {
    minWords = 75,
    maxWords = 150,
    requireSentenceCount,
    enforceNoImperatives = true,
  } = opts;

  const cleaned = text.trim();
  if (!cleaned) throw new Error(`"text" is empty.`);

  const wc = wordCount(cleaned);
  if (wc < minWords || wc > maxWords) {
    throw new Error(`Word count ${wc} outside ${minWords}–${maxWords}.`);
  }

  if (typeof requireSentenceCount === "number") {
    const sc = sentenceCount(cleaned);
    if (sc !== requireSentenceCount) {
      throw new Error(`Sentence count ${sc} != ${requireSentenceCount}.`);
    }
  }

  if (enforceNoImperatives) validateNoImperativeCoaching(cleaned);

  void role; // role-specific checks stay in prompts/roles.ts
}
