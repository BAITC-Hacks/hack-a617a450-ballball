import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createAssistant, AssistantError } from "../src/server/assistant/index.ts";
import { initializeCatalog } from "../src/server/products/index.ts";

// No SDK debug logger, environment dump, raw exception, or transcript files.
async function main() {
  let trace = process.argv.includes("--trace");
  const started = performance.now();
  const catalog = await initializeCatalog();
  if (trace) console.log(`[timing] ${JSON.stringify({ operation: "catalog-startup", durationMs: Math.round(performance.now() - started), ...catalog })}`);
  if (!catalog.available) console.log("Catalog index is not ready. Run npm run catalog:refresh. Searches can start warming it without waiting for the full download.");
  const assistant = createAssistant({ onTiming(event) { if (trace) console.log(`[timing] ${JSON.stringify(event)}`); }, onToolTrace(event) {
    if (trace) console.log(`[tool] ${JSON.stringify(event)}`);
  } });
  const terminal = createInterface({ input: stdin, output: stdout, historySize: 0 });
  console.log("EKT dev chat. /exit, /reset, /trace on, /trace off. Do not enter credentials or payment-card data.");
  try {
    while (true) {
      let message: string;
      try { message = await terminal.question("You: "); } catch { break; }
      if (message.trim() === "/exit") break;
      if (message.trim() === "/reset") { assistant.reset(); console.log("Conversation reset."); continue; }
      if (message.trim() === "/trace on") { trace = true; continue; }
      if (message.trim() === "/trace off") { trace = false; continue; }
      if (!message.trim()) continue;
      try { console.log(`EKT: ${(await assistant.send(message)).text}`); }
      catch (error) { console.error(error instanceof AssistantError ? error.message : "Assistant unavailable. Please try again."); }
    }
  } finally { terminal.close(); }
}
main().catch(() => { console.error("Unable to start assistant. Check server environment configuration."); process.exitCode = 1; });
