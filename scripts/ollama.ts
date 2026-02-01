type Msg = { role: "system" | "user" | "assistant"; content: string };

export async function ollamaChat(args: {
  model: string;
  messages: Msg[];
  temperature?: number;
  numPredict?: number;
}): Promise<string> {
  const res = await fetch("http://127.0.0.1:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: args.model,
      stream: false,
      keep_alive: -1,
      options: {
        temperature: args.temperature ?? 0.75,
        num_predict: args.numPredict ?? 220
      },
      messages: args.messages
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama error ${res.status}: ${text}`);
  }

  const json = (await res.json()) as any;
  const content = json?.message?.content;
  if (typeof content !== "string") throw new Error("Unexpected Ollama response shape");
  return content;
}
