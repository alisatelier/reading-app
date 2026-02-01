// src/engine.ts
import fs from "node:fs/promises";
import path from "node:path";

import { ollamaChat } from "./ollama.ts";
import { roleFromIdKey, roleRule } from "./roles.ts";
import {
  validateText,
  lintDiscouragedPhrases,
  wordCount,
  sentenceCount,
  hasImperativeVerbs,
  type Role,
} from "./validate.ts";

/**
 * Engine goals:
 * - Generate ONE card message (per-card atom), not holistic spread interpretation
 * - Repeatable scaffolding: same structure for different spreads/intentions/cards
 * - Reliable constraints: JSON only, 5 sentences, 75–150 words
 * - Repair instead of failing (especially for small wordcount misses)
 */

type MeaningFile = {
  cardId: string;
  cardName: string;
  upright: { themes: string[]; core: string[] };
  reversed: { themes: string[]; core: string[] };
};

export type CardGenInput = {
  spreadId: string; // e.g. "ppf"
  idKey: string; // e.g. "past-3"
  intentionId: string; // e.g. "ppf:growth:healing"
  intentionText: string; // e.g. "Where am I on my spiritual journey?"
  cardId: string; // e.g. "0.TheOne"
  cardName: string; // e.g. "The One"
  reversed: boolean;
};

export type CardGenOutput = {
  key: string;
  text: string; // paragraph only (UI can add prefix)
  createdAtISO: string;
};

// --------- Constraints / tuning knobs ----------
const MODEL = "mistral:latest";

// hard constraints
const MIN_WORDS = 75;
const MAX_WORDS = 150;

// sentence count is NOT hard (models are flaky). We'll soft-target 5.
const TARGET_SENTENCES = 5;
const MIN_SENTENCES = 4;
const MAX_SENTENCES = 6;

// soft target band (used to trigger repair, not hard fail)
const TARGET_MIN = 95;
const TARGET_MAX = 125;

// attempts
const MAX_DRAFT_ATTEMPTS = 4;
const MAX_REPAIRS_PER_DRAFT = 2;

// model params
const DRAFT_TEMP = 0.7;
const REPAIR_TEMP = 0.2;

// give enough output budget so it can hit 95–125 + JSON reliably
const DRAFT_NUM_PREDICT = 520;
const REPAIR_NUM_PREDICT = 900;

// --------------------------------------------

function safeTrim(s: string) {
  return (s ?? "").trim();
}

/**
 * Parse the model response as JSON-only and require exactly:
 *   {"text":"..."}
 */
function parseJsonOnly(raw: string): { text: string } {
  const trimmed = safeTrim(raw);

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error(
      `Model did not return JSON. Got: ${trimmed.slice(0, 180)}...`,
    );
  }

  const jsonStr = trimmed.slice(first, last + 1);

  let obj: any;
  try {
    obj = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`Invalid JSON: ${(e as Error).message}`);
  }

  if (!obj || typeof obj.text !== "string") {
    throw new Error(`JSON must be exactly {"text":"..."} (no other keys).`);
  }

  const extraKeys = Object.keys(obj).filter((k) => k !== "text");
  if (extraKeys.length) {
    throw new Error(`Extra JSON keys not allowed: ${extraKeys.join(", ")}`);
  }

  const text = safeTrim(obj.text);
  if (!text) throw new Error(`"text" is empty.`);
  return { text };
}

async function loadMajorMeaning(cardId: string): Promise<MeaningFile> {
  const file = path.join(
    process.cwd(),
    "data",
    "tarot",
    "meanings",
    "majors",
    `${cardId}.json`,
  );
  const raw = await fs.readFile(file, "utf8");
  if (!raw.trim()) throw new Error(`Meaning file is empty: ${file}`);
  return JSON.parse(raw);
}

function buildCanonBlock(m: MeaningFile, reversed: boolean): string[] {
  const side = reversed ? m.reversed : m.upright;
  return [
    `themes: ${side.themes.join(", ")}`,
    `core: ${side.core.join(" | ")}`,
  ];
}

/**
 * Pick two anchor core lines deterministically so outputs are repeatable.
 */
function pickCanonAnchors(
  m: MeaningFile,
  reversed: boolean,
  seedKey: string,
): string[] {
  const side = reversed ? m.reversed : m.upright;
  const core = side.core.filter(Boolean);

  if (core.length === 0) return ["", ""];
  if (core.length === 1) return [core[0], core[0]];
  if (core.length === 2) return [core[0], core[1]];

  // tiny deterministic hash
  let h = 2166136261;
  for (const ch of seedKey) h = (h ^ ch.charCodeAt(0)) * 16777619;

  const i1 = Math.abs(h) % core.length;
  const i2 = (i1 + 1 + (Math.abs(h >> 8) % (core.length - 1))) % core.length;

  return [core[i1], core[i2]];
}

function keywordsFromAnchor(anchor: string): string[] {
  return anchor
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => w.length >= 5);
}

/**
 * Anchor coverage: consider an anchor covered if 2+ keywords appear.
 * This is intentionally forgiving (we use it as a repair trigger).
 */
function scoreAnchorCoverage(text: string, anchors: string[]) {
  const t = text.toLowerCase();
  let matched = 0;

  for (const a of anchors) {
    const keys = keywordsFromAnchor(a);
    const hitCount = keys.reduce(
      (acc, k) => (t.includes(k) ? acc + 1 : acc),
      0,
    );
    if (hitCount >= 2) matched++;
  }
  return { matched, total: anchors.length };
}

function buildPrompts(
  input: CardGenInput,
  canonLines: string[],
  role: Role,
  anchors: string[],
) {
  const sys = [
    `You write ONE tarot message in a consistent voice: intimate, specific, grounded.`,
    `Use ONLY the provided canon meaning. Do not add meanings, events, or symbols not present in canon.`,
    `Output MUST be valid JSON only: {"text":"..."} (no other keys, no markdown, no labels).`,
    `You MUST reference the intention explicitly (reuse 1–3 key words from it), but do NOT quote it verbatim.`,
    `Aim for ${TARGET_SENTENCES} sentences (allowed ${MIN_SENTENCES}–${MAX_SENTENCES}).`,
    `Length target: ${TARGET_MIN}–${TARGET_MAX} words (must be within ${MIN_WORDS}–${MAX_WORDS}).`,
    `Each sentence must end with proper punctuation (., !, or ?).`,

    roleRule(role),

    input.reversed
      ? `Reversed: express as blocked/internal/restoring—NOT the opposite meaning.`
      : `Upright: express the core meaning clearly.`,

    `Do not mention the word "card".`,
    `Do NOT repeat the canon block verbatim or list themes as a comma-separated sequence. Paraphrase the canon into natural language.`,
    `Never use the words: "themes:", "core:", "canon".`,
    `Avoid sentence-leading imperatives (no sentences starting with Take/Try/Remember/Focus/Consider/Embrace).`,
    `1 vivid image maximum; no stacked metaphors; no clichés.`,
    `Structure: open with the ${role} tense, cover both anchors somewhere, and end by tying back to the intention with a short quote (2–6 words).`,
  ].join(" ");

  const user = [
    `Intention: ${input.intentionText}`,
    `Spread: ${input.spreadId}`,
    `Position idKey: ${input.idKey}`,
    `Role: ${role}`,
    `Card: ${input.cardName}${input.reversed ? " [Reversed]" : ""}`,
    `Canon meaning:\n- ${canonLines.join("\n- ")}`,
    `Canon anchors to cover (paraphrase both):\n- Anchor A: ${anchors[0]}\n- Anchor B: ${anchors[1]}`,
    `Write the message now as JSON only.`,
  ].join("\n");

  return { sys, user };
}

async function draftOnce(sys: string, user: string) {
  return ollamaChat({
    model: MODEL,
    temperature: DRAFT_TEMP,
    numPredict: DRAFT_NUM_PREDICT,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
  });
}

async function repairRewrite(
  sys: string,
  baseUser: string,
  badText: string,
  reason: string,
) {
  const repairUser = [
    baseUser,
    ``,
    `Previous output was rejected for: ${reason}`,
    `Rewrite the SAME message so it passes constraints.`,
    `Do NOT add new meanings beyond canon.`,
    `Must cover BOTH anchors (sentence 2 = Anchor A paraphrase, sentence 4 = Anchor B paraphrase).`,
    `Convert any imperative coaching ("Speak/Take/Try/Choose") into reflective, non-command phrasing.`,
    `You MUST reference the intention text at least once by quoting EXACTLY 2–6 consecutive words from it, embedded naturally in a sentence (no colon, no standalone quote line).`,
    `Do not use the word "remember" anywhere.`,
    `Do not include quoted advice or commands (no patterns like: Now, '...'; no colon + quote).`,
    `Avoid repetitive closers like "a testament to". Use one clean concluding sentence.`,
    `Do not say "themes of". Do not list words from canon; paraphrase.`,

    ``,
    `Previous JSON:`,
    JSON.stringify({ text: badText }),
  ].join("\n");

  return ollamaChat({
    model: MODEL,
    temperature: REPAIR_TEMP,
    numPredict: REPAIR_NUM_PREDICT,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: repairUser },
    ],
  });
}

function isWordCountError(msg: string) {
  return /Word count\s+\d+\s+outside\s+\d+–\d+/i.test(msg);
}

/**
 * Micro-repair for small length misses:
 * - keep 5 sentences
 * - add/remove 8–25 words
 * - do NOT introduce new meanings
 */
async function microRepairForLength(
  sys: string,
  baseUser: string,
  badText: string,
) {
  const wc = wordCount(badText);
  const needAtLeast = MIN_WORDS;

  // Much more forceful and specific than "add 8–25 words"
  const instruction =
    wc < MIN_WORDS
      ? [
          `Your text is ${wc} words. It MUST be at least ${MIN_WORDS} words.`,
          `Hard requirements: JSON only {"text":"..."}; ${MIN_WORDS}–${MAX_WORDS} words (aim ${TARGET_MIN}–${TARGET_MAX}); sentence count allowed ${MIN_SENTENCES}–${MAX_SENTENCES} (aim ${TARGET_SENTENCES}).`,
          `CRITICAL: Do NOT delete or replace any existing words. Preserve the original text verbatim.`,
          `Only INSERT ONE additional clause of 22–40 words into sentence 3 (mid-sentence).`,
          `The added clause must restate canon themes already present (no new meanings).`,
          `Return JSON only: {"text":"..."}.`,
        ].join(" ")
      : [
          `Your text is ${wc} words. It MUST be at most ${MAX_WORDS} words.`,

          `Remove ONE clause of 18–28 words from sentence 3 or 4.`,
          `Do NOT remove anchor coverage or the intention quote.`,
          `Return JSON only: {"text":"..."}.`,
        ].join(" ");

  const repairUser = [
    baseUser,
    ``,
    `Micro-repair for length only.`,
    instruction,
    ``,
    `Current JSON:`,
    JSON.stringify({ text: badText }),
  ].join("\n");

  return ollamaChat({
    model: MODEL,
    temperature: 0.05,
    numPredict: REPAIR_NUM_PREDICT,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: repairUser },
    ],
  });
}

function extractThemesFromCanonLines(canonLines: string[]): string[] {
  // expects a line like: "themes: a, b, c"
  const line = canonLines.find((l) => l.toLowerCase().startsWith("themes:"));
  if (!line) return [];
  return line
    .slice(line.indexOf(":") + 1)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "so",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "at",
  "by",
  "i",
  "me",
  "my",
  "mine",
  "you",
  "your",
  "yours",
  "we",
  "our",
  "ours",
  "is",
  "am",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "how",
  "what",
  "where",
  "when",
  "why",
  "can",
  "do",
  "does",
  "did",
  "should",
  "would",
  "could",
  "this",
  "that",
  "these",
  "those",
  "it",
  "as",
  "from",
  "into",
  "over",
  "under",
  "about",
  "now",
]);

function normalizeTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/["']/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((t) => t.replace(/^-+|-+$/g, ""));
}

function hasIntentionReference(text: string, intentionText: string): boolean {
  const intentTokens = normalizeTokens(intentionText).filter(
    (t) => !STOP_WORDS.has(t),
  );
  const textTokens = new Set(normalizeTokens(text));

  // require at least 1 meaningful token match (or 2 if intention has many tokens)
  const needed = intentTokens.length >= 5 ? 2 : 1;

  let hits = 0;
  for (const tok of intentTokens) {
    if (textTokens.has(tok)) hits++;
    if (hits >= needed) return true;
  }
  return false;
}

function intentionQuote(intentionText: string): string {
  const cleaned = intentionText
    .trim()
    .replace(/\s+/g, " ")
    .replace(/["']/g, "");

  // Prefer a meaningful slice after common question starters
  const starters = [
    "where am i",
    "what is",
    "what can",
    "how can",
    "how do",
    "should i",
    "is it",
    "what will",
  ];

  const lower = cleaned.toLowerCase();
  for (const s of starters) {
    const idx = lower.indexOf(s);
    if (idx !== -1) {
      const tail = cleaned.slice(idx).split(/\s+/).filter(Boolean);
      // pick 2–6 words, but avoid ending on tiny function words
      const phrase = tail.slice(0, Math.min(6, tail.length)).join(" ");
      const trimmed = phrase.replace(/\b(my|the|a|an|on|in|of|to|for)$/i, "");
      if (trimmed.split(/\s+/).length >= 2) return trimmed;
    }
  }

  // fallback: take 2–6 words from the middle (avoids "Where am I on my")
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length <= 6) return cleaned;

  const mid = Math.floor(words.length / 2);
  const start = Math.max(0, mid - 2);
  const phrase = words.slice(start, start + 5).join(" ");
  const trimmed = phrase.replace(/\b(my|the|a|an|on|in|of|to|for)$/i, "");
  return trimmed.split(/\s+/).length >= 2
    ? trimmed
    : words.slice(start, start + 4).join(" ");
}

function padSentence3ToMinWords(
  text: string,
  role: Role,
  themes: string[],
  intentionText: string,
  minWords: number,
): string {
  const wc = wordCount(text);
  if (wc >= minWords) return text;

  // Split into sentences (you already validate sentence count elsewhere)
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length < 3) return text;

  const t = themes.slice(0, 3);
  const [a, b, c] = [t[0] ?? "trust", t[1] ?? "focus", t[2] ?? "openness"];

  // Role-aware phrasing (no imperatives, no "card suggests", no coaching)
  const intentTokens = normalizeTokens(intentionText).filter(
    (t) => !STOP_WORDS.has(t),
  );
  const intentHint = intentTokens.slice(0, 2).join(" ") || "intention";

  const rolePhrase =
    role === "past"
      ? `In that season, ${a} and ${b} steadied you, and ${c} stayed honest inside your ${intentHint}.`
      : role === "present"
        ? `In this season, ${a} and ${b} steady you, and ${c} stays honest inside your ${intentHint}.`
        : `In the season ahead, ${a} and ${b} will steady you, and ${c} will stay honest inside your ${intentHint}.`;

  const extra =
    role === "past"
      ? `It shaped how you chose when certainty wasn’t available.`
      : role === "present"
        ? `It shapes how you choose even without certainty.`
        : `It will shape how you choose even without certainty.`;

  // Ensure sentence 3 ends with exactly one period
  const s3 = sentences[2].replace(/[.!?]+$/, "");
  sentences[2] =
    `${s3} ${rolePhrase} ${extra}`.replace(/\s+/g, " ").trim() + ".";

  return sentences.join(" ");
}

function makeKey(input: CardGenInput) {
  return `${input.spreadId}|${input.idKey}|${input.intentionId}|${input.cardId}|${
    input.reversed ? "r" : "u"
  }`;
}

function looksLikeThemeDump(text: string): boolean {
  // catches "themes of X, Y, Z" and long comma lists
  if (/themes of\s+[^.]{30,}/i.test(text)) return true;
  // comma-heavy sentence (very common when it dumps your theme list)
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  return sentences.some((s) => (s.match(/,/g)?.length ?? 0) >= 4);
}


export async function generateCardMessage(
  input: CardGenInput,
): Promise<CardGenOutput> {
  const role = roleFromIdKey(input.idKey);

  const meaning = await loadMajorMeaning(input.cardId);
  const canonLines = buildCanonBlock(meaning, input.reversed);

  const anchors = pickCanonAnchors(
    meaning,
    input.reversed,
    `${input.intentionId}|${input.cardId}|${input.idKey}|${input.reversed ? "r" : "u"}`,
  );

  const { sys, user } = buildPrompts(input, canonLines, role, anchors);

  let lastErr: string | null = null;
  let lastText: string | null = null;

  for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt++) {
    const raw = await draftOnce(sys, user);

    let text = "";
    try {
      ({ text } = parseJsonOnly(raw));

      // hard validation first
      validateText(text, role, {
        minWords: MIN_WORDS,
        maxWords: MAX_WORDS,
        enforceNoImperatives: true,
      });

      // soft checks -> repair triggers
      const hits = lintDiscouragedPhrases(text);
      const cov = scoreAnchorCoverage(text, anchors);
      const wc = wordCount(text);
      const sc = sentenceCount(text);

      const needsRepair =
        cov.matched < cov.total ||
        hits.length >= 2 ||
        wc < TARGET_MIN ||
        wc > TARGET_MAX ||
        sc < MIN_SENTENCES ||
        sc > MAX_SENTENCES ||
        hasImperativeVerbs(text) ||
        !hasIntentionReference(text, input.intentionText) ||
        lookslikeThemeDump(text);

      if (!needsRepair) {
        return {
          key: makeKey(input),
          text,
          createdAtISO: new Date().toISOString(),
        };
      }

      // repair loop for soft issues (and also can polish into target band)
      let working = text;
      let reason = `soft-checks: coverage=${cov.matched}/${cov.total}, discouragedHits=${hits.length}, wc=${wc}, sc=${sc}`;

      for (let r = 1; r <= MAX_REPAIRS_PER_DRAFT; r++) {
        const repairedRaw = await repairRewrite(sys, user, working, reason);
        const parsed = parseJsonOnly(repairedRaw);
        working = parsed.text;

        // hard re-validate
        validateText(working, role, {
          minWords: MIN_WORDS,
          maxWords: MAX_WORDS,
          enforceNoImperatives: true,
        });

        const hits2 = lintDiscouragedPhrases(working);
        const cov2 = scoreAnchorCoverage(working, anchors);
        const wc2 = wordCount(working);

        // success condition for soft targets
        if (
          cov2.matched === cov2.total &&
          hits2.length <= 1 &&
          wc2 >= TARGET_MIN &&
          wc2 <= TARGET_MAX
        ) {
          return {
            key: makeKey(input),
            text: working,
            createdAtISO: new Date().toISOString(),
          };
        }

        reason = `soft-checks: coverage=${cov2.matched}/${cov2.total}, discouragedHits=${hits2.length}, wc=${wc2}`;
      }

      // If repairs didn’t hit soft-perfect but remain hard-valid AND anchor-covered, accept.
      const covFinal = scoreAnchorCoverage(working, anchors);
      if (covFinal.matched === covFinal.total) {
        return {
          key: makeKey(input),
          text: working,
          createdAtISO: new Date().toISOString(),
        };
      }

      lastText = working;
      lastErr = `Soft targets not met after repairs (coverage=${covFinal.matched}/${covFinal.total}).`;
    } catch (e) {
      lastErr = (e as Error).message;
      if (text) lastText = text;

      if (text && isWordCountError(lastErr)) {
        try {
          // 1) Try LLM micro-repair first
          const repairedRaw = await microRepairForLength(sys, user, text);
          const parsed = parseJsonOnly(repairedRaw);
          let repairedText = parsed.text;

          // 2) If still short, pad deterministically in code (guaranteed)
          const themes = extractThemesFromCanonLines(canonLines);
          const q = intentionQuote(input.intentionText);
          repairedText = padSentence3ToMinWords(
            repairedText,
            role,
            themes,
            q,
            MIN_WORDS,
          );

          // 3) Re-validate inside try. If it still fails, keep looping.
          validateText(repairedText, role, {
            minWords: MIN_WORDS,
            maxWords: MAX_WORDS,
            enforceNoImperatives: true,
          });

          return {
            key: makeKey(input),
            text: repairedText,
            createdAtISO: new Date().toISOString(),
          };
        } catch (e) {
          lastErr = `Micro-repair failed: ${(e as Error).message}`;
          lastText = text;
          continue;
        }
      }

      // otherwise continue attempts
    }
  }

  // Final fallback: ONLY return if it is mechanically valid (no invalid best-effort).
  if (lastText) {
    try {
      validateText(lastText, role, {
        minWords: MIN_WORDS,
        maxWords: MAX_WORDS,
        enforceNoImperatives: true,
      });

      // If it’s valid but outside target band, do a last micro-repair attempt.
      const wc = wordCount(lastText);
      if (wc < TARGET_MIN || wc > TARGET_MAX) {
        const repairedRaw = await microRepairForLength(sys, user, lastText);
        const parsed = parseJsonOnly(repairedRaw);
        const repairedText = parsed.text;

        validateText(repairedText, role, {
          minWords: MIN_WORDS,
          maxWords: MAX_WORDS,
          enforceNoImperatives: true,
        });

        return {
          key: makeKey(input),
          text: repairedText,
          createdAtISO: new Date().toISOString(),
        };
      }

      console.warn(
        `Returning mechanically-valid fallback. Last error: ${lastErr ?? "unknown"}`,
      );
      return {
        key: makeKey(input),
        text: lastText,
        createdAtISO: new Date().toISOString(),
      };
    } catch {
      // fall through to throw
    }
  }

  throw new Error(
    `Failed to generate valid output. Last error: ${lastErr ?? "unknown"}`,
  );
}
