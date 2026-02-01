// scripts/test-gen.ts
import { generateCardMessage } from "./engine";

async function main() {
  console.log("[test-gen] start");

  const started = Date.now();

  try {
    console.log("[test-gen] calling generateCardMessage...");

    const out = await generateCardMessage({
      spreadId: "ppf",
      idKey: "past-3",
      intentionId: "ppf:growth:healing",
      intentionText: "Where am I on my spiritual journey?",
      cardId: "2.TheEnchantress",
      cardName: "The Enchantress",
      reversed: false,
    });

    console.log("[test-gen] success in", Date.now() - started, "ms");
    console.log("[test-gen] engine version: microRepairClause-v1");

    console.dir(out, { depth: null });
  } catch (err) {
    console.error("[test-gen] ERROR:", err);
    process.exitCode = 1;
  } finally {
    console.log("[test-gen] end");
  }
}

main();
