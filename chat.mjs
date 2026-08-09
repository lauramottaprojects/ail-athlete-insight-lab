#!/usr/bin/env node
/**
 * Athlete Insight Lab (AIL) - terminal chat
 *
 * Talks to the AIL backend (Vercel serverless function), which:
 *  - queries the live Google Sheets dataset at every question, and
 *  - runs the five-agent pipeline (Lumen -> Prism -> Canvas -> Echo -> Nexus)
 *    using Gemini 3.1 Flash-Lite. The Gemini key stays server-side.
 *
 * Usage:
 *   node chat.mjs
 *   node chat.mjs --trace        (also print each agent's raw output)
 *   node chat.mjs --url https://your-deployment.vercel.app
 *
 * Environment:
 *   AIL_API_URL   backend base URL (default: https://ailcodebase.vercel.app)
 */

import readline from "node:readline";

const args = process.argv.slice(2);
const showTrace = args.includes("--trace");
const urlFlag = args.indexOf("--url");
const API_BASE = (urlFlag !== -1 && args[urlFlag + 1]) || process.env.AIL_API_URL || "https://ailcodebase.vercel.app";
const API_URL = `${API_BASE.replace(/\/$/, "")}/api/chat`;

const AGENTS = ["Lumen", "Prism", "Canvas", "Echo", "Nexus"];

function banner() {
  console.log("\n" + "=".repeat(64));
  console.log("  ATHLETE INSIGHT LAB - five-agent chat (live data)");
  console.log("  Pipeline: Lumen -> Prism -> Canvas -> Echo -> Nexus");
  console.log("  Data: Google Sheets (live, queried at each question)");
  console.log(`  Model: Gemini 3.1 Flash-Lite via backend ${API_BASE}`);
  console.log("  Type 'exit' or Ctrl+C to quit.");
  console.log("=".repeat(64) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let closed = false;
let busy = false;
rl.on("close", () => { closed = true; if (!busy) process.exit(0); });

function ask(prompt) {
  if (closed) return Promise.resolve("");
  return new Promise((resolve) => rl.question(prompt, resolve));
}

async function chat() {
  banner();
  for (;;) {
    if (closed) return;
    const q = (await ask("You: ")).trim();
    if (closed) return;
    if (!q) continue;
    if (/^(exit|quit|bye)$/i.test(q)) { console.log("Nexus: Goodbye - happy running!"); process.exit(0); }
    process.stdout.write("\nPipeline running: ");
    const t = setInterval(() => process.stdout.write("."), 600);
    busy = true;
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: q }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `Server error ${res.status}`);
      }
      const data = await res.json();
      clearInterval(t);
      console.log("\n");
      console.log("--- AIL ---");
      console.log(data.answer);
      console.log("\n" + "-".repeat(64));
      if (showTrace) {
        console.log("-".repeat(64));
        for (const agent of data.trace) {
          console.log(`\n[${agent.agent} - ${agent.role}]`);
          console.log(agent.output);
        }
      }
      console.log("-".repeat(64) + "\n");
    } catch (err) {
      clearInterval(t);
      console.log("\nPipeline error: " + err.message + "\n");
    } finally {
      busy = false;
    }
  }
}

chat().catch((e) => { console.error(e); process.exit(1); });
