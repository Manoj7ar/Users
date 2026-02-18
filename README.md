# USERS — One-Shot Visual Workflow Learning Agent

**Show it once. It works forever.**

USERS is a Chrome Extension that lets you perform any browser-based workflow once while narrating it, then executes that exact workflow autonomously on every future run. It navigates entirely by visual understanding of screenshots — zero DOM access, zero brittle selectors. It works across any web app visible in a browser tab: Google Sheets, Docs, Slack, Gmail, Salesforce, any SaaS product.

The system has three modes: **TEACH** (record a workflow by doing it once), **EXECUTE** (run it automatically with a single click), and **RECOVER** (ask the user a plain-English question when something looks ambiguous, then continue). Workflow steps are stored as semantic graph nodes in Firestore — not fragile CSS selectors — making them resilient to UI changes.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Chrome Extension                          │
│                                                                  │
│  ┌──────────┐   messages   ┌──────────────────┐                 │
│  │ popup.js │ ◄──────────► │  background.js   │                 │
│  │ (UI)     │              │  (Service Worker) │                 │
│  └──────────┘              └────────┬─────────┘                 │
│                                     │ fetch                      │
│  ┌──────────┐   messages            │                            │
│  │content.js│ ◄─────────────────────┘                           │
│  │(actions) │                                                    │
│  └──────────┘                                                    │
└─────────────────────────────────────┬───────────────────────────┘
                                      │ HTTPS
                        ┌─────────────▼──────────────┐
                        │    Google Cloud Run          │
                        │    FastAPI Backend           │
                        │                              │
                        │  ┌─────────────────────┐    │
                        │  │  main.py (FastAPI)  │    │
                        │  └──────────┬──────────┘    │
                        │             │                │
                        │  ┌──────────▼──────────┐    │
                        │  │  agent.py (ADK)     │    │
                        │  │  - analyze_screenshot│    │
                        │  │  - build_step_node  │    │
                        │  │  - check_verification│    │
                        │  └──────────┬──────────┘    │
                        │             │                │
                        │  ┌──────────▼──────────┐    │
                        │  │ gemini_client.py     │    │
                        │  │ Gemini 2.0 Flash     │    │
                        │  │ (google-generativeai)│    │
                        │  └─────────────────────┘    │
                        └──────┬──────────────┬────────┘
                               │              │
              ┌────────────────▼──┐    ┌──────▼────────────────┐
              │  Cloud Firestore  │    │  Cloud Speech-to-Text  │
              │  (workflow store) │    │  (audio transcription) │
              └───────────────────┘    └────────────────────────┘
```

---

## Prerequisites

- **Node.js** (not required for the extension itself — just for any build tooling if you add it)
- **Python 3.11+**
- **Google Cloud account** with billing enabled
- **gcloud CLI** installed and authenticated (`gcloud auth login`)
- A **Gemini API key** from [Google AI Studio](https://aistudio.google.com/apikey)

---

## Local Development Setup

### 1. Clone the repository

```bash
git clone https://github.com/your-org/users-extension.git
cd users-extension
```

### 2. Set up the Python backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 3. Configure environment variables

```bash
cp .env.example .env
# Edit .env and set:
#   GEMINI_API_KEY=your_api_key_here
#   GOOGLE_CLOUD_PROJECT=your-gcp-project-id
```

For Firestore, either:
- Set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json`, or
- Run `gcloud auth application-default login` to use your personal credentials locally

### 4. Run the backend locally

```bash
cd backend
uvicorn main:app --reload --port 8080
```

The API will be available at `http://localhost:8080`. Check health: `curl http://localhost:8080/health`

### 5. Load the extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer Mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder
5. The USERS extension icon will appear in your toolbar
6. Click the icon to open the popup — you should see the Dashboard screen

The extension defaults to `http://localhost:8080` as the backend URL. No additional config needed for local development.

---

## GCP Deployment

### 1. Set environment variables

```bash
export GEMINI_API_KEY=your_gemini_api_key
export GOOGLE_CLOUD_PROJECT=your-gcp-project-id
```

### 2. Create a Firestore database

```bash
gcloud firestore databases create --region=us-central1 --project=$GOOGLE_CLOUD_PROJECT
```

### 3. Run the deploy script

```bash
cd backend
./deploy.sh
```

This will:
- Enable all required GCP APIs
- Build the Docker image via Cloud Build
- Push to Container Registry
- Deploy to Cloud Run in `us-central1`
- Print the deployed service URL

### 4. Update the extension with the Cloud Run URL

After deployment, update the backend URL in the extension. The easiest way is via the browser console:

```javascript
// Open any tab, open DevTools console, then:
chrome.storage.local.set({ backendUrl: 'https://users-backend-xxxx-uc.a.run.app' })
```

Or hard-code it in `extension/background.js`:

```javascript
const DEFAULT_BACKEND_URL = 'https://users-backend-xxxx-uc.a.run.app';
```

---

## How to Use USERS

### Step 1 — Install

Load the `extension/` folder as an unpacked extension in Chrome (see Local Development Setup above).

### Step 2 — Teach

1. Click the USERS icon in Chrome toolbar
2. Click **+ Teach New Workflow**
3. Type a name for your workflow (e.g. "Export Monthly Report")
4. Click **Start Recording**
5. Speak aloud what you're doing ("Now I'm clicking the Reports tab…")
6. Perform the workflow normally in the browser — every click is captured
7. When done, click **Stop & Save**

USERS will analyze each screenshot with Gemini 2.0 Flash, build a semantic workflow graph, and save it to Firestore.

### Step 3 — Execute

1. Open the USERS popup
2. Your saved workflow appears in the Dashboard
3. Click **▶ Run**
4. USERS takes over: it captures screenshots, uses Gemini to identify each element by sight, and simulates the clicks/typing
5. If it's unsure about something, it pauses and asks you a plain-English question
6. When done, you'll see all steps checked off ✓

---

## Tech Stack

| Layer | Technology |
|---|---|
| Chrome Extension | Manifest V3, Service Worker, Web Speech API |
| UI Framework | Vanilla JS + CSS custom properties |
| Backend | Python 3.11, FastAPI, Uvicorn |
| AI Vision | Gemini 2.0 Flash (`google-generativeai` SDK) |
| Agent Orchestration | Google ADK (`google-adk`) |
| Workflow Storage | Google Cloud Firestore |
| Audio Transcription | Web Speech API (client-side) + Cloud Speech-to-Text (server-side) |
| Deployment | Google Cloud Run + Cloud Build |
| Image Processing | Pillow |

---

## Project Structure

```
users-extension/
├── extension/               # Chrome Extension (Manifest V3)
│   ├── manifest.json
│   ├── popup.html
│   ├── popup.css
│   ├── popup.js
│   ├── background.js        # Service Worker
│   ├── content.js           # Injected into all pages
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
└── backend/                 # Python FastAPI backend
    ├── main.py              # All FastAPI endpoints
    ├── agent.py             # Google ADK agent + tools
    ├── gemini_client.py     # Gemini 2.0 Flash calls
    ├── firestore_client.py  # Firestore read/write
    ├── speech_client.py     # Cloud Speech-to-Text
    ├── models.py            # Pydantic data models
    ├── requirements.txt
    ├── Dockerfile
    ├── cloudbuild.yaml
    ├── deploy.sh
    └── .env.example
```

---

## Hackathon Submission Checklist

- [x] **Gemini 2.0 Flash** via `google-generativeai` SDK (not REST API)
- [x] **Google ADK** (`google-adk`) for agent orchestration and tool-use
- [x] **Google Cloud Run** — Dockerfile + `cloudbuild.yaml` + `deploy.sh`
- [x] **Google Cloud Firestore** — workflow graph storage
- [x] **Google Cloud Speech-to-Text** — `speech_client.py` (server-side)
- [x] **Web Speech API** — real-time transcription in Teach Mode (client-side)
- [x] **Manifest V3** — service worker, not background page
- [x] **Zero DOM access** for element detection — Gemini finds elements from screenshots only
- [x] **Normalized coordinates** (0.0–1.0) for all screen positions
