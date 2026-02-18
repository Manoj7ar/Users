"""
Gemini 2.0 Flash client — all vision/reasoning calls go through here.
Uses the official google-genai Python SDK (replaces deprecated google-generativeai).
"""
from __future__ import annotations

import base64
import json
import logging
import os
from io import BytesIO
from typing import Any

from google import genai
from google.genai import types as genai_types
from PIL import Image

logger = logging.getLogger(__name__)

# ── Initialise SDK ─────────────────────────────────────────────
_client: genai.Client | None = None


def get_client() -> genai.Client:
    global _client
    if _client is None:
        api_key = os.getenv("GEMINI_API_KEY", "")
        if api_key:
            _client = genai.Client(api_key=api_key)
        else:
            # Fall back to Vertex AI via Application Default Credentials
            project = os.getenv("GOOGLE_CLOUD_PROJECT", "")
            _client = genai.Client(vertexai=True, project=project, location="us-central1")
    return _client


# Keep a legacy name for backwards compat inside this module
def get_model():
    return get_client()


# ── Prompt Templates ───────────────────────────────────────────

TEACH_STEP_PROMPT = """
You are analyzing a screenshot taken during a workflow recording session.
The user just clicked something and narrated: "{narration}"
The click context (nearby visible text) was: "{click_context}"

Analyze the screenshot and return ONLY a valid JSON object with this exact structure:
{{
  "intent": "one clear sentence describing what the user intended to do at this step",
  "visual_cue": "describe the visual appearance of what they clicked: color, shape, label, position",
  "action_type": "click|type|navigate|scroll|extract_value",
  "target_description": "describe the target element in plain English a person would understand",
  "input_value": "if they typed something, what did they type. Otherwise null",
  "stores_to": "if they extracted a value (like a number), what variable name to store it in. Otherwise null",
  "verification_cue": "what visual change should happen on screen after this action succeeds",
  "confidence_threshold": 0.82
}}
Return ONLY the JSON. No markdown. No explanation.
"""

EXECUTE_STEP_PROMPT = """
You are executing step {step_index} of a saved workflow.
Step intent: {intent}
Visual cue to find: {visual_cue}
Target description: {target_description}

Look at the current screenshot. Find the element that matches the description above.
Return ONLY a valid JSON object:
{{
  "found": true/false,
  "confidence": 0.0-1.0,
  "x": normalized x coordinate (0.0 to 1.0 from left edge),
  "y": normalized y coordinate (0.0 to 1.0 from top edge),
  "reasoning": "brief explanation of what you found or why you couldn't find it",
  "recovery_question": "if confidence < 0.75, a plain English question to ask the user. Otherwise null"
}}
Return ONLY the JSON. No markdown. No explanation.
"""

VERIFICATION_PROMPT = """
Before this action: here is the expected change that should have occurred: {verification_cue}
Look at the current screenshot. Did this change happen?
Return ONLY JSON: {{"verified": true/false, "confidence": 0.0-1.0, "observation": "what you see"}}
"""

FINALIZE_WORKFLOW_PROMPT = """
You are reviewing a workflow that was just recorded. Below are the raw step nodes as JSON.
Your job is to:
1. Ensure each step's intent is clear and concise.
2. Fill in any missing visual_cue or target_description fields.
3. Return a one-sentence summary of what the entire workflow does.

Steps JSON:
{steps_json}

Return ONLY a JSON object:
{{
  "steps": [ ... same structure as input, with improvements ... ],
  "summary": "one sentence describing what this workflow does"
}}
Return ONLY the JSON. No markdown. No explanation.
"""


# ── Helpers ────────────────────────────────────────────────────

def decode_and_resize(screenshot_b64: str, max_width: int = 1024) -> bytes:
    """Decode base64 PNG, resize to max_width, return PNG bytes."""
    try:
        raw = base64.b64decode(screenshot_b64)
        img = Image.open(BytesIO(raw))
        if img.width > max_width:
            ratio = max_width / img.width
            new_size = (max_width, int(img.height * ratio))
            img = img.resize(new_size, Image.LANCZOS)
        buf = BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    except Exception as e:
        logger.error("Image decode/resize failed: %s", e)
        raise


def _parse_json_response(text: str) -> dict[str, Any]:
    """Robustly parse JSON from model response, stripping any markdown fences."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].startswith("```") else lines[1:])
    return json.loads(text)


# ── Public API ─────────────────────────────────────────────────

async def build_step_node(
    screenshot_b64: str,
    narration: str,
    click_context: str,
) -> dict[str, Any]:
    """
    Call Gemini with a screenshot + narration + click context.
    Returns a StepNode-shaped dict.
    """
    client = get_client()
    png_bytes = decode_and_resize(screenshot_b64)
    prompt = TEACH_STEP_PROMPT.format(
        narration=narration or "(no narration)",
        click_context=click_context or "(no context)"
    )

    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents=[
            genai_types.Part.from_bytes(data=png_bytes, mime_type="image/png"),
            prompt,
        ],
    )

    raw = response.text or ""
    data = _parse_json_response(raw)
    return data


async def locate_element(
    screenshot_b64: str,
    step_index: int,
    intent: str,
    visual_cue: str,
    target_description: str,
) -> dict[str, Any]:
    """
    Call Gemini with a screenshot + step description.
    Returns { found, confidence, x, y, reasoning, recovery_question }.
    """
    client = get_client()
    png_bytes = decode_and_resize(screenshot_b64)
    prompt = EXECUTE_STEP_PROMPT.format(
        step_index=step_index,
        intent=intent,
        visual_cue=visual_cue,
        target_description=target_description,
    )

    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents=[
            genai_types.Part.from_bytes(data=png_bytes, mime_type="image/png"),
            prompt,
        ],
    )

    raw = response.text or ""
    data = _parse_json_response(raw)
    return data


async def check_verification(
    screenshot_b64: str,
    verification_cue: str,
) -> dict[str, Any]:
    """
    Call Gemini to verify that a step's expected change happened.
    Returns { verified, confidence, observation }.
    """
    client = get_client()
    png_bytes = decode_and_resize(screenshot_b64)
    prompt = VERIFICATION_PROMPT.format(verification_cue=verification_cue)

    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents=[
            genai_types.Part.from_bytes(data=png_bytes, mime_type="image/png"),
            prompt,
        ],
    )

    raw = response.text or ""
    data = _parse_json_response(raw)
    return data


async def finalize_workflow(steps: list[dict]) -> dict[str, Any]:
    """
    Ask Gemini to clean up a list of StepNode dicts and generate a summary.
    Returns { steps: [...], summary: str }.
    """
    client = get_client()
    steps_json = json.dumps(steps, indent=2, default=str)
    prompt = FINALIZE_WORKFLOW_PROMPT.format(steps_json=steps_json)

    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents=prompt,
    )

    raw = response.text or ""
    data = _parse_json_response(raw)
    return data
