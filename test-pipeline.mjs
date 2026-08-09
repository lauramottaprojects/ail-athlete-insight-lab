/**
 * Local pipeline test - runs the five-agent pipeline directly (no HTTP).
 * Requires GEMINI_API_KEY in the environment.
 *
 * Usage: node test-pipeline.mjs "your question"
 */

import { runPipeline } from "./api/chat.mjs";

const question = process.argv.slice(2).join(" ") || "What was my average sleep score in the last month?";

console.log(`Question: ${question}`);
console.log("Fetching live Google Sheets data and running Lumen -> Prism -> Canvas -> Echo -> Nexus...\n");

const started = Date.now();
const result = await runPipeline(question);
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log(`Done in ${seconds}s | Decision: ${result.decision}`);
console.log(`Live data: ${result.data.source} (fetched at ${result.data.fetchedAt})\n`);
console.log("=".repeat(70));
console.log("FINAL ANSWER");
console.log("=".repeat(70));
console.log(result.answer);
console.log("\n" + "=".repeat(70));
console.log("AGENT TRACE");
console.log("=".repeat(70));
for (const t of result.trace) {
  console.log(`\n--- ${t.agent} (${t.role}) ---`);
  console.log(t.output);
}
