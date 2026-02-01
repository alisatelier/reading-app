import fs from "node:fs/promises";
import path from "node:path";
import { ollamaChat } from "./ollama.js";
import { roleFromIdKey, roleRule } from "./roles.js";
import { mustNotContainTodo, parseJsonOnly, validateText } from "./validate.js";

type MeaningFile = {
  cardId: string;
  cardName: string;
  upright: { themes: string[]; core: string[] };
  reversed: { themes: string[]; core: string[] };
};


export type CardGenInput = {
  spreadId: "ppf";
  idKey: "past-3" | "present-3" | "future-3";
  intentionId: "ppf:growth:healing";
  intentionText: string;
  cardId: string;       // e.g. "17.Healing"
  cardName: string;     // e.g. "Healing"
  reversed: boolean;
};

export type CardGenOutput = {
  key: string;
  text: string;         // paragraph only (UI can add prefix)
  createdAtISO: string;
};

async function loadMajorMeaning(cardId: string): Promise<MeaningFile> {
  const file = path.join(process.cwd(), "data", "tarot", "meanings", "majors", `${cardId}.json`);
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw);
}

function buildCanonBlock(m: MeaningFile, reversed: boolean): string[] {
  const side = reversed ? m.reversed : m.upright;
  return [
    `themes: ${side.themes.join(", ")}`,
    `core: ${side.core.join(" | ")}`
  ];
}


function buildPrompts(input: CardGenInput, canonLines: string[], role: "past" | "present" | "future") {
  const sys = [
    `You write one tarot card message in a consistent style.`,
    `Use ONLY the provided canon meaning. Do not add new meanings.`,
    `Output MUST be valid JSON only: {"text":"..."} (no other keys, no markdown).`,
    `Length: 75–150 words.`,
    roleRule(role),
    input.reversed
      ? `Reversed: express as blocked/internal/restoring—NOT the opposite meaning.`
      : `Upright: express the core meaning clearly.`,
    `Tie every sentence to the intention.`,
    `Avoid generic filler like "be mindful", "reflect", "moving forward".`
  ].join(" ");

  const user = [
    `Intention: ${input.intentionText}`,
    `Spread: ${input.spreadId}`,
    `Position idKey: ${input.idKey}`,
    `Card: ${input.cardName}${input.reversed ? " [Reversed]" : ""}`,
    `Canon meaning:\n- ${canonLines.join("\n- ")}`,
    `Write the message now.`
  ].join("\n");

  return { sys, user };
}

export async function generateCardMessage(input: CardGenInput): Promise<CardGenOutput> {
  // role from idKey
  const role = roleFromIdKey(input.idKey);

  // load canon meaning
  const meaning = await loadMajorMeaning(input.cardId);
  const canonLines = buildCanonBlock(meaning, input.reversed);

  // refuse to generate if not authored yet
  mustNotContainTodo(canonLines);

  const { sys, user } = buildPrompts(input, canonLines, role);

  // one retry if JSON/constraints fail
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await ollamaChat({
      model: "mistral:latest",
      temperature: attempt === 1 ? 0.75 : 0.6,
      numPredict: 240,
      messages: [
        { role: "system", content: sys + (attempt === 2 ? " IMPORTANT: Return JSON only." : "") },
        { role: "user", content: user }
      ]
    });

    const { text } = parseJsonOnly(raw);
    try {
      validateText(text, role);
      const key = `${input.spreadId}|${input.idKey}|${input.intentionId}|${input.cardId}|${input.reversed ? "r" : "u"}`;
      return {
        key,
        text,
        createdAtISO: new Date().toISOString()
      };
    } catch (e) {
      if (attempt === 2) throw e;
    }
  }

  throw new Error("Unreachable");
}

