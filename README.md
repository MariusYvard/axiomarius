# AxioMariuS

**Data distilled. Insights delivered.**

AxioMariuS is a local OSINT enrichment tool that fills your Excel CRM with LinkedIn contact data and tension signals using a local LLM via Ollama. No API keys. No cloud. Runs entirely on your machine.

Part of the [Marius Intelligence Suite](#marius-intelligence-suite).

---

## What it does

For each lead in your CRM:

1. **LinkedIn enrichment** - Finds the most senior HR/People decision-maker at the company and writes their name, title, and LinkedIn URL into the spreadsheet.
2. **Signal detection** - Searches for recent tension signals (restructuring, layoffs, leadership changes) via DuckDuckGo (primary) with Google as fallback for small companies with limited coverage. Writes a short label and verbatim into the CRM.

Results are ready for [Vantarius](https://github.com/MariusYvard/vantarius) to use as outreach context.

---

## Requirements

- Node.js >= 18
- [Ollama](https://ollama.com) running locally with at least one model installed
- A LinkedIn account (login done manually once via `node setup.js`)
- An Excel CRM file (`.xlsx`)

---

## Setup

```bash
# 1. Install dependencies
npm install
#    Installs rebrowser-puppeteer, which patches the Runtime.Enable CDP leak
#    detected by Cloudflare and LinkedIn anti-bot systems.

# 2. Copy and edit the config
cp config.yaml config.yaml   # already included, just edit it

# 3. Install a model in Ollama (if you haven't already)
ollama pull gemma3:12b       # or any model you prefer

# 4. Log in to LinkedIn (one-time)
node setup.js
# A browser will open - log in, then close the window.
```

Edit `config.yaml` to match your CRM structure (column indices, sheet name, eligible pipeline stages).

---

## Usage

```bash
# Enrich all eligible leads
npm start

# Preview what would happen (no CRM changes)
npm run dry-run

# Start fresh (clear resume checkpoint)
npm run reset
```

AxioMariuS automatically resumes from where it left off if interrupted. No lead is processed twice in the same 24h window.

---

## CRM structure

Your Excel file needs at minimum these columns (exact positions configured in `config.yaml`):

| Column | Field | Description |
|--------|-------|-------------|
| A | Company | Company name |
| B | Stage | Pipeline stage (e.g. "New") |
| C | First name | Contact first name (written by AxioMariuS) |
| D | Last name | Contact last name |
| E | Title | Contact job title |
| F | LinkedIn URL | Profile URL |
| G | Signal | Tension signal label |
| H | Notes | AI verbatims and reasoning |

Column positions are fully configurable in `config.yaml`.

---

## Configuration

All settings live in `config.yaml`. Key sections:

```yaml
crm:
  file: "CRM.xlsx"       # your spreadsheet
  sheet: "Pipeline"      # worksheet name
  data_start_row: 2      # first data row (1 = header)
  eligible_stages:       # which rows to enrich
    - "New"

llm:
  model: "gemma3:12b"    # any Ollama model

linkedin:
  session_dir: "./chrome-session"
  delay_min: 3000        # ms between leads (anti-detection)
  delay_max: 7000

signals:
  web_keywords:          # terms to search for per company
    - restructuring
    - layoffs
    - merger
    - reorganization
    - turnover
```

---

## Project structure

```
axiomarius/
├── config.yaml           Edit this
├── setup.js              LinkedIn login (run once)
├── src/
│   ├── main.js           Orchestrator
│   ├── linkedin.js       LinkedIn scraping + LLM profile selection
│   ├── web_enricher.js   Signal search (DuckDuckGo primary, Google fallback)
│   ├── cache.js          Signal cache (30-day TTL)
│   ├── checkpoint.js     Run resume system
│   ├── crm_writer.js     Atomic Excel write
│   ├── config_loader.js  YAML config reader
│   └── logger.js         Console + file logging
└── .github/workflows/    CI
```

---

## Marius Intelligence Suite

AxioMariuS and [Vantarius](https://github.com/MariusYvard/vantarius) form a two-stage pipeline:

```
AxioMariuS      →      Vantarius
(OSINT)                (Outreach)
Enrich CRM      →      Read signal → generate message → send invite
```

They can be used independently or together.

---

## License

MIT