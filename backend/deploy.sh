#!/usr/bin/env bash
# ── USERS Backend — One-Command GCP Deployment ────────────────
# Usage: ./deploy.sh
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - GEMINI_API_KEY environment variable set
#   - GOOGLE_CLOUD_PROJECT environment variable set (or gcloud config project set)

set -euo pipefail

# ── Validate environment ──────────────────────────────────────
if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  echo "ERROR: GEMINI_API_KEY is not set."
  echo "  export GEMINI_API_KEY=your_api_key_here"
  exit 1
fi

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
if [[ -z "${PROJECT_ID}" ]]; then
  echo "ERROR: GOOGLE_CLOUD_PROJECT is not set and no default gcloud project found."
  echo "  export GOOGLE_CLOUD_PROJECT=your-gcp-project-id"
  exit 1
fi

REGION="${REGION:-us-central1}"
SERVICE_NAME="users-backend"
IMAGE="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  USERS Backend — Deploying to Cloud Run"
echo "  Project : ${PROJECT_ID}"
echo "  Region  : ${REGION}"
echo "  Service : ${SERVICE_NAME}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Enable required APIs (idempotent) ─────────────────────────
echo ""
echo "[1/4] Enabling GCP APIs…"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  containerregistry.googleapis.com \
  firestore.googleapis.com \
  speech.googleapis.com \
  --project="${PROJECT_ID}" \
  --quiet

# ── Submit build via Cloud Build ──────────────────────────────
echo ""
echo "[2/4] Building and pushing Docker image via Cloud Build…"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gcloud builds submit \
  --config="${SCRIPT_DIR}/cloudbuild.yaml" \
  --substitutions="_GEMINI_API_KEY=${GEMINI_API_KEY}" \
  --project="${PROJECT_ID}" \
  "${SCRIPT_DIR}"

# ── Deploy to Cloud Run ───────────────────────────────────────
echo ""
echo "[3/4] Deploying to Cloud Run…"
gcloud run deploy "${SERVICE_NAME}" \
  --image="${IMAGE}:latest" \
  --platform=managed \
  --region="${REGION}" \
  --allow-unauthenticated \
  --set-env-vars="GEMINI_API_KEY=${GEMINI_API_KEY},GOOGLE_CLOUD_PROJECT=${PROJECT_ID}" \
  --memory=1Gi \
  --cpu=1 \
  --concurrency=80 \
  --timeout=300 \
  --project="${PROJECT_ID}" \
  --quiet

# ── Get deployed URL ──────────────────────────────────────────
echo ""
echo "[4/4] Retrieving deployed service URL…"
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --platform=managed \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --format="value(status.url)")

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Deployment complete!"
echo ""
echo "  Service URL: ${SERVICE_URL}"
echo ""
echo "  Next step: Update BACKEND_URL in the Chrome extension"
echo "  Open extension/background.js and set:"
echo "    const DEFAULT_BACKEND_URL = '${SERVICE_URL}';"
echo "  Or use chrome.storage.local to set backendUrl at runtime."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
