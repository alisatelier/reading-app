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
      return `Past role: formative. Prefer "may have", "had to", "this formed". Keep it grounded in what shaped the present.`;
    case "present":
      return `Present role: current state. Prefer "right now", "is", "currently", "underway". Describe what is happening in the healing process now.`;
    case "future":
      return `Future role: trajectory. Include exactly ONE sentence starting with "If". Describe what may develop in the healing process next.`;
  }
}
