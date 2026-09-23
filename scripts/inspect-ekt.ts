import { mkdir, writeFile } from "node:fs/promises";
import { getProducts, getProductById } from "../src/server/ekt/client.ts";
import { EktApiError } from "../src/server/ekt/errors.ts";

// Responses stay in a Git-ignored directory, with private permissions.
const directory = new URL("../.ekt-inspection/", import.meta.url);
await mkdir(directory, { recursive: true, mode: 0o700 });

const probes = [
  { name: "products-page-1", run: () => getProducts(1) },
  { name: "products-page-2", run: () => getProducts(2) },
  { name: "product-515291", run: () => getProductById(515291) },
];

for (const probe of probes) {
  try {
    const result = await probe.run();
    await writeFile(new URL(`${probe.name}.json`, directory), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    console.log(`${probe.name}: OK; saved in .ekt-inspection/${probe.name}.json`);
  } catch (error) {
    if (error instanceof EktApiError) {
      console.error(`${probe.name}: ${error.code}: ${error.message}`);
    } else {
      console.error(`${probe.name}: Unexpected inspection failure.`);
    }
    process.exitCode = 1;
  }
}
