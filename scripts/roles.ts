export type Role = "past" | "present" | "future";

export function roleFromIdKey(idKey: string): Role {
  const k = idKey.toLowerCase();
  if (k.startsWith("past-")) return "past";
  if (k.startsWith("present-")) return "present";
  if (k.startsWith("future-")) return "future";
  throw new Error(`Unsupported idKey for this scaffold: ${idKey}`);
}

export function roleRule(role: Role): string {
  switch (role) {
    case "past":
      return `Past role: formative/backstory. Use past-tense framing ("you learned", "you faced", "you carried", "this shaped"). This is a theme that has already happened. Use past-tense. No "now it's time". Absolutely no foreshadowing or advising on the present or future.`;
    case "present":
      return `Present role: current state. Use present-tense framing ("right now", "is", "currently", "underway"). Do NOT mention any specific intention topic unless it is explicitly provided.`;
    case "future":
      return `Future role: trajectory. Use future/conditional framing. Include exactly ONE sentence starting with "If". Do NOT mention any specific intention topic unless it is explicitly provided.`;
  }
}
