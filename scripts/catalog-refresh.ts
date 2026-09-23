import { refreshCatalog } from "../src/server/products/index.ts";
import { EktApiError } from "../src/server/ekt/errors.ts";
const started = performance.now();
console.log("Refreshing catalog discovery index; no OpenAI requests are made.");
try {
  const coverage = await refreshCatalog();
  console.log(JSON.stringify({ durationMs: Math.round(performance.now() - started), coverage }));
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof EktApiError ? error.code : "CACHE_IO", durationMs: Math.round(performance.now() - started) }));
  process.exitCode = 1;
}
