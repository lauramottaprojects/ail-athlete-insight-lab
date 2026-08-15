# Athlete Insight Lab (AIL) - Agentic Organisation Prototype

A fully agentic organisation powered by five specialised AI agents that collaborate to turn
live wearable data into clear running insights. Submission for the H9CEAI Final Project:
*Build an Agentic Organisation*.

- **Organisation:** Athlete Insight Lab (AIL) - see `Five Agent Designs - Athlete Insight Lab.md`
- **Pipeline:** Lumen (Researcher) -> Prism (Designer) -> Canvas (Maker) -> Echo (Communicator) -> Nexus (Manager)
- **Live data:** Google Sheets (Athlete Insight Lab dataset), queried at run time on every
  dashboard load and on every chat question - never hardcoded, never cached.
- **Chat intelligence:** Gemini 3.1 Flash-Lite, called once per agent through the backend
  proxy. The API key lives only in the Vercel `GEMINI_API_KEY` environment variable.
- **Multi-turn chat:** the chat keeps the conversation fluid. The client sends the last 20
  messages of history with every question, and every agent sees that transcript, so
  follow-ups like "yes", "tell me more" or "what about sleep?" are answered in context
  instead of being treated as a brand-new topic. A "New chat" button resets the transcript.

## What is in this repo

| File | Purpose |
|------|---------|
| `index.html` | Web frontend (GitHub Pages): live dashboard + chat |
| `api/chat.mjs` | Vercel serverless function: live data fetch + five-agent pipeline (Gemini proxy) |
| `chat.mjs` | Terminal chat that talks to the deployed backend |
| `test-pipeline.mjs` | Local pipeline test (needs `GEMINI_API_KEY` env var) |
| `vercel.json` | Vercel deployment configuration |

## How the live data connection works

Both surfaces query Google at the moment of use:

- The frontend fetches the public sheet CSVs directly from the browser at load/refresh time:
  `https://docs.google.com/spreadsheets/d/<id>/export?format=csv&gid=<gid>`
- The backend re-fetches the same sheets on **every chat question** inside the pipeline
  (see `fetchLiveData()` in `api/chat.mjs`) and hands the live rows to the Lumen and Canvas
  agents. There are no hardcoded data values anywhere in the code.

## Running locally

```bash
# Terminal chat (uses the deployed backend)
node chat.mjs
node chat.mjs --trace          # also print every agent's raw output

# Full pipeline locally (no HTTP), with your Gemini key in the environment
$env:GEMINI_API_KEY="..."      # PowerShell
node test-pipeline.mjs "How much have I run this month?"
```

## Deployment notes

- Frontend: pushed to the `main` branch; GitHub Pages serves `/` from `main`.
- Backend: deployed with the Vercel CLI. Set `GEMINI_API_KEY` (sensitive) in the Production
  environment - never commit it or ship it client-side.

## Security

- No secret keys or credentials are committed to this repository.
- The Gemini key is only referenced through `process.env.GEMINI_API_KEY` on the server.
- The `.gitignore` excludes token files, `.env`, and local Vercel state.
