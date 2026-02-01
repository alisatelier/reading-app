import intentions from "../data/intentions.json" assert { type: "json" };
import { generateCardMessage } from "./engine.ts";

async function main() {
  const intentionId = "ppf:growth:healing";
  const intentionText = intentions[intentionId].label;

  // pick ONE major arcana card you have authored in JSON:
  const cardId = "0.TheOne";
  const cardName = "The One";

  // test one slot at a time (per-card generation)
  const out = await generateCardMessage({
    spreadId: "ppf",
    idKey: "past-3",
    intentionId,
    intentionText,
    cardId,
    cardName,
    reversed: false
  });

  // Your UI formatting (engine returns paragraph only)
  console.log(`\nPast: ${cardName} - ${out.text}\n`);
  console.log(`(key: ${out.key})\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
