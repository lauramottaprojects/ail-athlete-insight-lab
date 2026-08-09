/**
 * Athlete Insight Lab (AIL) - Agentic Organisation prototype
 * Vercel serverless function: /api/chat
 *
 * This function is the backend of the AIL chat. It:
 *  1. Fetches the athlete dataset LIVE from Google Sheets at query time
 *     (a real network call to Google; nothing is hardcoded or cached).
 *  2. Runs the five-agent pipeline (Lumen -> Prism -> Canvas -> Echo -> Nexus),
 *     one Gemini call per agent, each with its own system prompt and personality.
 *  3. Proxies Gemini (model: gemini-3.1-flash-lite). The API key lives ONLY in
 *     the Vercel GEMINI_API_KEY environment variable - never client-side.
 */

const SHEET_ID = "1MZCLWcd_CYuvPrd4iV3YL8FVAip1tF9E6njJnpu2nIY";
const GID_ACTIVITIES = "960494473";
const GID_SLEEP = "401471431";
const MODEL = "gemini-3.1-flash-lite";
const DATA_SOURCE = "Google Sheets - Athlete Insight Lab dataset (live)";

const DATA_URLS = {
  activities: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID_ACTIVITIES}`,
  sleep: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID_SLEEP}`,
};

// Fast-path: clear in-scope keywords (training / activity / sleep data or the product).
// Anything without these goes to a small Gemini scope-guard call.
const IN_SCOPE_RE =
  /\b(run|running|jog|jogging|cycle|cycling|bike|riding|swim|swimming|train|training|workout|gym|lift|lifting|sleep|sleeping|recovery|recover|readiness|fatigue|heart\s*rate|\bhr\b|pulse|distance|pace|cadence|\btss\b|stress|progress|progressing|performance|endurance|fitness|athlete|activity|activities|kilometre|kilometer|\bkm\b|mile|miles|calorie|calories|vo2|marathon|race|sprint|stamina|rest|consistent|volume|peak|base|conditioning)\b/i;

async function classifyScope(question) {
  if (IN_SCOPE_RE.test(question)) return "IN_SCOPE";
  try {
    const verdict = await gemini(
      `You are the scope guard for "Athlete Insight Lab" (AIL), an educational prototype. It answers questions ONLY about one athlete's live training, activity and sleep data (running, cycling, swimming, heart rate, distance, pace, cadence, training stress, sleep score, recovery, readiness, progress, fatigue, performance) and about how the AIL product itself works. The user has no other data available to you.
Classify the user's message. Reply with exactly one token: IN_SCOPE if it asks about that athlete data or about the AIL product; otherwise OUT_OF_SCOPE.`,
      `User message: ${question}`
    );
    const norm = verdict.replace(/[\s_\-:.]/g, "").toUpperCase();
    return norm.includes("OUTOFSCOPE") ? "OUT_OF_SCOPE" : "IN_SCOPE";
  } catch {
    return "IN_SCOPE"; // be permissive if the guard call fails
  }
}

// ---------------------------------------------------------------------------
// Live data access (queried at the moment of use - never stored, never hardcoded)
// ---------------------------------------------------------------------------

async function fetchLiveData() {
  const fetchedAt = new Date().toISOString();
  const [activitiesCsv, sleepCsv] = await Promise.all([
    fetch(DATA_URLS.activities).then((r) => r.text()),
    fetch(DATA_URLS.sleep).then((r) => r.text()),
  ]);
  return {
    activitiesCsv,
    sleepCsv,
    source: DATA_SOURCE,
    fetchedAt,
  };
}

// Simple state-machine CSV parser (handles quoted fields with commas, e.g. "31,46").
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

// European decimal commas ("31,46" -> 31.46). Strips units and "--".
function toNum(v) {
  if (v === undefined || v === null) return null;
  let s = String(v).trim();
  if (s === "--" || s === "" || s === "-") return null;
  s = s.replace(/\s+/g, "").replace(/"/g, "").replace(/[hms]/g, "");
  if (s.includes(",")) s = s.replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// "6:41:42" or "0:36:26" -> minutes
function hmsToMinutes(v) {
  const n = toNum(v); // after comma->dot, parseFloat of "6:41:42" gives 6 - not right
  if (v === undefined || v === null) return null;
  const parts = String(v).trim().split(":");
  if (parts.length === 3) {
    const [h, m, s] = parts.map((p) => parseFloat(p));
    if ([h, m, s].every((x) => Number.isFinite(x))) return h * 60 + m + s / 60;
  }
  if (parts.length === 2) {
    const [m, s] = parts.map((p) => parseFloat(p));
    if ([m, s].every((x) => Number.isFinite(x))) return m + s / 60;
  }
  return null;
}

// "7h 36min" / "7h 1min" -> minutes
function sleepDurToMinutes(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  const h = s.match(/(\d+)\s*h/);
  const m = s.match(/(\d+)\s*min/);
  const hours = h ? parseInt(h[1], 10) : 0;
  const mins = m ? parseInt(m[1], 10) : 0;
  return hours * 60 + mins;
}

// "8/1/26 8:22" (M/D/YY H:MM) -> Date
function parseActivityDate(v) {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})[ ,](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, mo, d, yy, hh, mm] = m;
  const year = parseInt(yy, 10) >= 70 ? 1900 + parseInt(yy, 10) : 2000 + parseInt(yy, 10);
  return new Date(year, parseInt(mo, 10) - 1, parseInt(d, 10), parseInt(hh, 10), parseInt(mm, 10));
}

function computeSummary(activitiesCsv, sleepCsv) {
  const actRows = parseCSV(activitiesCsv);
  const sleepRows = parseCSV(sleepCsv);
  const actHeader = actRows[0];
  const idx = (name) => actHeader.indexOf(name);

  const iType = idx("Activity Type");
  const iDate = idx("Date");
  const iDist = idx("Distance");
  const iCal = idx("Calories");
  const iTime = idx("Time");
  const iHr = idx("Avg HR");
  const iTss = idx("Training Stress Score" in actHeader ? idx("Training Stress Score") : actHeader.findIndex((h) => h.startsWith("Training")));
  const iTss2 = actHeader.findIndex((h) => h && h.trim().startsWith("Training Stress"));
  const iCad = idx("Avg Cadence");

  const byType = {};
  const distanceByWeek = {};
  let totalDistance = 0;
  let totalMinutes = 0;
  let hrSum = 0;
  let hrCount = 0;
  let tssSum = 0;
  let runCount = 0;

  for (let r = 1; r < actRows.length; r++) {
    const row = actRows[r];
    const type = (row[iType] || "Unknown").trim();
    byType[type] = (byType[type] || 0) + 1;

    const d = toNum(row[iDist]);
    const t = hmsToMinutes(row[iTime]);
    const hr = toNum(row[iHr]);
    const tss = toNum(row[iTss2] !== -1 ? row[iTss2] : undefined);

    if (d !== null && d > 0) totalDistance += d;
    if (t !== null) totalMinutes += t;
    if (hr !== null) {
      hrSum += hr;
      hrCount++;
    }
    if (tss !== null) tssSum += tss;
    if (/run/i.test(type)) runCount++;

    const date = parseActivityDate(row[iDate]);
    if (date && d !== null && d > 0) {
      const key = `${date.getFullYear()}-W${Math.floor((date.getDate() - 1) / 7) + 1}-M${date.getMonth() + 1}`;
      distanceByWeek[key] = (distanceByWeek[key] || 0) + d;
    }
  }

  const sHeader = sleepRows[0];
  const siScore = sHeader.indexOf("Avg Score");
  const siDur = sHeader.indexOf("Avg Duration");
  const siNeed = sHeader.indexOf("Avg Sleep Need");
  const siQuality = sHeader.indexOf("Avg Quality");
  const recentScores = [];
  let avgDurationMin = 0;
  let avgNeedMin = 0;
  let qualityCounts = {};
  const sleepRowsData = sleepRows.slice(1);
  for (let i = 0; i < sleepRowsData.length; i++) {
    const row = sleepRowsData[i];
    const score = toNum(row[siScore]);
    if (score !== null) recentScores.push(score);
    const dur = sleepDurToMinutes(row[siDur]);
    const need = sleepDurToMinutes(row[siNeed]);
    if (dur !== null) avgDurationMin += dur;
    if (need !== null) avgNeedMin += need;
    const q = (row[siQuality] || "").trim();
    if (q) qualityCounts[q] = (qualityCounts[q] || 0) + 1;
  }
  if (sleepRowsData.length) {
    avgDurationMin /= sleepRowsData.length;
    avgNeedMin /= sleepRowsData.length;
  }

  const totalMinutes_ = totalMinutes;
  return {
    activities: {
      rows: actRows.length - 1,
      byType,
      totalDistanceKm: Math.round(totalDistance * 100) / 100,
      totalDurationMin: Math.round(totalMinutes_),
      totalHours: Math.round(totalMinutes_ / 60 * 10) / 10,
      avgHr: hrCount ? Math.round(hrSum / hrCount) : null,
      totalTss: Math.round(tssSum),
      runCount,
      latestActivityDate: actRows.length > 1 ? actRows[actRows.length - 1][iDate] : null,
    },
    sleep: {
      rows: sleepRows.length - 1,
      avgScore: recentScores.length ? Math.round(recentScores.reduce((a, b) => a + b, 0) / recentScores.length) : null,
      avgDurationMin: Math.round(avgDurationMin),
      avgSleepNeedMin: Math.round(avgNeedMin),
      qualityCounts,
      latestWeek: sleepRowsData.length ? sleepRowsData[0][0] : null,
    },
    recentWeeksDistance: distanceByWeek,
  };
}

// ---------------------------------------------------------------------------
// The five agents (system prompts from the AIL Five Agent Designs file)
// ---------------------------------------------------------------------------

const AGENTS = {
  Lumen: {
    archetype: "Researcher",
    system: `You are Lumen, the Training Insights Analyst at Athlete Insight Lab (AIL). You are Agent 1, the Researcher, in this pipeline: Researcher -> Designer -> Maker -> Communicator -> Manager.
MISSION: Analyse only the athlete activity and sleep records supplied live to you by the application and produce a factual Research Brief for Prism, the Designer. Treat the user's question as the focus of the analysis: define what the question is asking, which records are needed to answer it, and which other signals are relevant context.
DATA RULES: Separate live retrieved records, interpretations, and unknowns. Never invent dates, distances, time, heart rate, cadence, training stress score, sleep score, or duration. If data is missing, write "not provided". Always state that the data source is the AIL demonstration dataset (Google Sheets) and never claim a real wearable account (for example Garmin or Strava) was accessed.
ANALYSIS: Summarise training volume (weekly distance and time), intensity distribution, training-load trend, consistency, sleep and recovery patterns (sleep score, duration versus sleep need), and overall performance evolution. Identify progress signals, fatigue signals, and the clearest opportunity for the athlete, such as readiness to progress to the next performance level or a recovery concern.
LIMITS: You are an analyst, not a medical professional. Do not diagnose, predict injury, or recommend training through pain.
OUTPUT exactly: A. Data source and retrieval status; B. Athlete profile summary; C. Observed training and recovery patterns; D. Progress and fatigue signals; E. Opportunity and readiness assessment; F. Data gaps and limitations; G. Handoff instructions for Prism. Do not design the answer; that is Prism's task.`,
  },
  Prism: {
    archetype: "Designer",
    system: `You are Prism, the Insight Experience Designer at Athlete Insight Lab (AIL). You are Agent 2, the Designer, in this pipeline: Researcher -> Designer -> Maker -> Communicator -> Manager.
MISSION: Convert Lumen's Research Brief into a clear and realistic answer-design specification. You design the solution; Canvas will compute it and Echo will deliver it. Scope the design to answering the user's question clearly and directly in the chat, reusing the AIL dashboard design language so the answer feels like part of the same product.
DESIGN PRINCIPLES: One dashboard, one story. Show the athlete where they are, how they are progressing, and what comes next. Prioritise clarity over complexity: every number must be explainable in plain language. Design for beginners and busy runners with glanceable insights and supportive alerts for fatigue or readiness changes.
TRACEABILITY: Reference each metric Lumen surfaced in the Research Brief. Do not invent metrics, thresholds, or comparisons that the data cannot support. If a metric is missing or the brief is unclear, mark NEEDS_REVIEW instead of inventing a design.
SAFETY: Alerts must be supportive, never alarmist. Do not claim to detect, predict, or treat injury. Keep the language of recovery positive.
OUTPUT exactly: A. Design objective; B. Audience and user needs; C. Which metrics answer the question; D. How the answer should be structured and visualised; E. Supporting context to include; F. Alerts or caveats to show; G. Acceptance criteria for Canvas. Do not write the final customer message; that is Echo's task.`,
  },
  Canvas: {
    archetype: "Maker",
    system: `You are Canvas, the Dashboard and Analytics Pipeline Builder at Athlete Insight Lab (AIL). You are Agent 3, the Maker, in this pipeline: Researcher -> Designer -> Maker -> Communicator -> Manager.
MISSION: Turn Prism's Design Specification into a working, structured, validated result. You are the only agent that works with the raw live dataset. Query the live Google Sheets data supplied to you at query time and compute the exact numbers the user asked for.
IMPLEMENTATION RULES: Use only the live retrieved records supplied to you in this call. Do not invent, round up, or approximate values that are not in the data. Preserve the data source and retrieval time. Validate dates, units, missing values, and aggregation correctness. If a requested metric cannot be computed from the available data, say so explicitly rather than guessing.
SAFETY: Do not diagnose, predict injury, guarantee performance, or instruct training through pain.
OUTPUT exactly: A. The question being answered; B. Live data source and retrieval time; C. The computed answer with the exact supporting numbers; D. The trend or comparison requested (for example weekly, monthly, by activity type); E. Supporting statistics; F. Data-quality notes and assumptions; G. Anything that could not be computed; H. Handoff instructions for Echo.`,
  },
  Echo: {
    archetype: "Communicator",
    system: `You are Echo, the Insights Narrator at Athlete Insight Lab (AIL). You are Agent 4, the Communicator, in this pipeline: Researcher -> Designer -> Maker -> Communicator -> Manager.
MISSION: Explain Canvas's validated result without changing its numbers, dates, metrics, or safety conditions. Deliver the answer directly in the chat: clear, complete, and tailored to how the user asked it.
RULES: Be CONCISE - answer the question directly in a few short sentences (2-4), using only the numbers that answer it. No long openings, no repeated explanations, no filler paragraphs. Explain what the data shows and why it matters in plain language. Adapt tone to the audience: supportive for a beginner, concise for a busy runner. Treat recovery and rest as part of the story. Include the data-source disclosure (AIL demonstration dataset) in one short clause and any safety note. Invite a follow-up question in a single short sentence.
TRUTHFULNESS: Never claim to have accessed a real wearable account unless the input confirms a genuine connection. For the demonstration, say "Athlete Insight Lab demonstration dataset". Never invent completed sessions, biometric values, or progress. Do not make performance guarantees.
SAFETY: Do not diagnose or provide medical treatment. Present alerts supportively and recommend appropriate professional support where relevant. Do not encourage training through pain.
OUTPUT exactly: A. Personalised opening; B. The direct answer to the question; C. Why it matters (context); D. What to do next; E. Data-source disclosure; F. Safety and support note; G. Invitation for a follow-up question. Do not change any number provided by Canvas.`,
  },
  Nexus: {
    archetype: "Manager",
    system: `You are Nexus, the Chief Insights Officer at Athlete Insight Lab (AIL). You are Agent 5, the Manager and final quality gate, in this pipeline: Researcher -> Designer -> Maker -> Communicator -> Manager.
MISSION: Review Lumen, Prism, Canvas, and Echo. Ensure the final answer is accurate, coherent, traceable, aligned with AIL's mission of clarity, and ethically responsible, and then approve it for the customer.
CHECK: Confirm the four earlier agents ran in order; the data source and retrieval time are truthful; Lumen analysed only live supplied data; Prism designed only metrics the data supports; Canvas computed from the live dataset; Echo did not alter the figures; the data-source disclosure and limitations are present; no diagnosis, injury prediction, performance guarantee, or training-through-pain instruction appears.
DECISION: Approve Echo's message only when it is coherent, data-grounded, traceable, safe, and CONCISE. If a metric is unsupported, a disclosure is missing, or the answer is wrong, rewrite the customer-facing message yourself with corrections and note what you fixed.
OUTPUT exactly: A. Pipeline status (all five agents ran in order); B. Data traceability (source, retrieval time, metrics used); C. Coherence and quality review; D. Safety and trust review; E. Decision APPROVE / REVISED; F. The FINAL ANSWER section containing the exact customer-facing message to send. The FINAL ANSWER must begin with "FINAL ANSWER:" and contain the complete approved message the user will see. Keep the FINAL ANSWER short and direct (a few sentences). Remove filler, repetition and any paragraphs that add no information.`,
  },
};

const PIPELINE = [
  { name: "Lumen", role: "Researcher" },
  { name: "Prism", role: "Designer" },
  { name: "Canvas", role: "Maker" },
  { name: "Echo", role: "Communicator" },
  { name: "Nexus", role: "Manager" },
];

// ---------------------------------------------------------------------------
// Gemini proxy
// ---------------------------------------------------------------------------

async function gemini(systemPrompt, userText) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY environment variable is not set");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: userText }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { temperature: 0.4, maxOutputTokens: 3000 },
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") || "";
  if (!text) throw new Error("Gemini returned an empty response");
  return text;
}

// ---------------------------------------------------------------------------
// The pipeline (exported so it can be tested outside Vercel too)
// ---------------------------------------------------------------------------

export async function runPipeline(question) {
  const scope = await classifyScope(question);
  if (scope === "OUT_OF_SCOPE") {
    return {
      answer: "That's outside what I can help with. I only answer questions about your live training, activity and sleep data - for example running volume, heart rate, sleep score, readiness, progress or fatigue.",
      decision: "OUT_OF_SCOPE",
      data: { source: DATA_SOURCE, fetchedAt: new Date().toISOString(), summary: null },
      trace: [],
      outOfScope: true,
    };
  }

  const live = await fetchLiveData();
  const summary = computeSummary(live.activitiesCsv, live.sleepCsv);

  const dataPackage = [
    `LIVE DATA SOURCE: ${live.source}`,
    `RETRIEVED AT: ${live.fetchedAt}`,
    `DATA SUMMARY (computed from the live rows at query time):`,
    JSON.stringify(summary, null, 1),
    ``,
    `RAW ACTIVITIES SHEET (live rows):`,
    live.activitiesCsv.slice(0, 60000),
    ``,
    `RAW SLEEP SHEET (live rows):`,
    live.sleepCsv.slice(0, 15000),
  ].join("\n");

  const trace = [];
  let context = "";

  for (const step of PIPELINE) {
    const agent = AGENTS[step.name];
    let userContent = "";
    if (step.name === "Lumen") {
      userContent = `The user asked: "${question}"\n\n${dataPackage}`;
    } else if (step.name === "Canvas") {
      userContent = `The user asked: "${question}"\n\nPRIOR AGENT OUTPUT:\n${context}\n\nLIVE DATA:\n${dataPackage}`;
    } else {
      userContent = `The user asked: "${question}"\n\nPRIOR AGENT OUTPUT:\n${context}`;
    }
    const output = await gemini(agent.system, userContent);
    trace.push({ agent: step.name, role: step.role, archetype: agent.archetype, output });
    context = context + `\n\n--- ${step.name} (${step.role}) OUTPUT ---\n${output}`;
  }

  // Nexus produces the FINAL ANSWER. Extract it for the chat response.
  const nexusOutput = trace[trace.length - 1].output;
  const answer = extractFinalAnswer(nexusOutput);

  return {
    answer,
    decision: /REVISED/i.test(nexusOutput) ? "REVISED" : "APPROVE",
    data: {
      source: live.source,
      fetchedAt: live.fetchedAt,
      summary,
    },
    trace,
  };
}

// Robustly extract the customer-facing message after "FINAL ANSWER" (handles
// bold markers, unusual whitespace, missing colon, and answers on later lines).
function extractFinalAnswer(nexusOutput) {
  const lines = nexusOutput.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^\s*FINAL\s*ANSWER\s*:?\s*\*{0,2}/i.test(l));
  if (idx !== -1) {
    const rest = lines.slice(idx + 1).join("\n").trim();
    if (rest) return rest;
  }
  const m = nexusOutput.match(/FINAL\s*ANSWER\s*:?\s*([\s\S]*)$/i);
  return (m ? m[1] : nexusOutput).trim();
}

// ---------------------------------------------------------------------------
// Vercel serverless handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(
      JSON.stringify({
        service: "Athlete Insight Lab - agentic chat backend",
        model: MODEL,
        dataSource: DATA_SOURCE,
        status: "ok",
      })
    );
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    let body = {};
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    } catch {
      body = {};
    }
    const question = String(body.message || "").trim();
    if (!question) {
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: "A message is required." }));
      return;
    }

    const result = await runPipeline(question);
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ error: err.message || "Internal server error" }));
  }
}

// ---------------------------------------------------------------------------
// Local self-test: `node api/chat.mjs "your question"`
// ---------------------------------------------------------------------------

import { fileURLToPath } from "node:url";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const q = process.argv.slice(2).join(" ") || "What was my average sleep score in the last month?";
  console.log("Question:", q);
  console.log("Fetching live data and running the five-agent pipeline...");
  const result = await runPipeline(q);
  console.log("\n--- DATA ---");
  console.log(result.data.source, "| fetched at", result.data.fetchedAt);
  console.log("\n--- ANSWER ---");
  console.log(result.answer);
  console.log("\n--- TRACE (5 agents) ---");
  for (const t of result.trace) {
    console.log(`\n[${t.agent} - ${t.role}]`);
    console.log(t.output.slice(0, 800) + (t.output.length > 800 ? "\n..." : ""));
  }
}
