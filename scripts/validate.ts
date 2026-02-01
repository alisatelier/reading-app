export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export function mustNotContainTodo(canonBullets: string[]) {
  const joined = canonBullets.join(" ").toLowerCase();
  if (joined.includes("todo")) {
    throw new Error("Canon meaning contains TODO. Fill in your card meaning JSON before generating.");
  }
}

export function parseJsonOnly(output: string): { text: string } {
  // Models sometimes wrap JSON with whitespace; trim first.
  const t = output.trim();

  let obj: any;
  try {
    obj = JSON.parse(t);
  } catch {
    throw new Error(`Model did not return valid JSON only. Got:\n${output}`);
  }

  if (!obj || typeof obj.text !== "string") {
    throw new Error(`JSON must have shape {"text":"..."}. Got:\n${t}`);
  }

  return { text: obj.text.trim() };
}

export function validateText(text: string, role: "past" | "present" | "future") {
  const wc = wordCount(text);
  if (wc < 75 || wc > 150) throw new Error(`Word count ${wc} outside 75–150.`);

  if (role === "future") {
    const ifCount = text.split(/\bIf\b/).length - 1;
    if (ifCount !== 1) throw new Error(`Future role requires exactly ONE "If" sentence. Found ${ifCount}.`);
  }
}
