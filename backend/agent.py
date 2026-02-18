"""
Google ADK agent for USERS — visual workflow orchestration.

Uses google-adk Agent with explicit tool definitions.
The agent orchestrates screenshot analysis, element location,
action generation, verification, and recovery.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from google.adk.agents import LlmAgent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService

import gemini_client
import firestore_client

logger = logging.getLogger(__name__)

# ── Tool Definitions ──────────────────────────────────────────
# ADK uses function docstrings + type hints to build the LLM schema.

async def analyze_screenshot(
    screenshot_b64: str,
    step_intent: str,
    visual_cue: str,
    target_description: str,
    step_index: int = 0,
) -> Dict[str, Any]:
    """
    Analyze a screenshot to locate a UI element for a workflow step.

    Args:
        screenshot_b64: Base64-encoded PNG screenshot.
        step_intent: Human-readable intent of this step (e.g. 'Click Submit Report button').
        visual_cue: Visual appearance of the target element (color, shape, label, position).
        target_description: Plain-English description of what to find.
        step_index: The index of the current step in the workflow.

    Returns:
        Dict with keys: found (bool), confidence (float 0-1), x (float), y (float),
        reasoning (str), recovery_question (str or None).
    """
    try:
        result = await gemini_client.locate_element(
            screenshot_b64=screenshot_b64,
            step_index=step_index,
            intent=step_intent,
            visual_cue=visual_cue,
            target_description=target_description,
        )
        return {"status": "success", **result}
    except Exception as e:
        logger.error("analyze_screenshot failed: %s", e)
        return {
            "status": "error",
            "found": False,
            "confidence": 0.0,
            "x": 0.5,
            "y": 0.5,
            "reasoning": str(e),
            "recovery_question": f"I couldn't analyze the screenshot: {e}. What should I click?",
        }


async def build_step_node(
    screenshot_b64: str,
    transcript: str,
    click_context: str,
) -> Dict[str, Any]:
    """
    Build a StepNode from a screenshot, narration transcript, and click context.

    Args:
        screenshot_b64: Base64-encoded PNG screenshot.
        transcript: What the user was saying when they performed this action.
        click_context: Human-readable description of the DOM context near the click.

    Returns:
        StepNode dict with keys: intent, visual_cue, action_type, target_description,
        input_value, stores_to, verification_cue, confidence_threshold.
    """
    try:
        data = await gemini_client.build_step_node(
            screenshot_b64=screenshot_b64,
            narration=transcript,
            click_context=click_context,
        )
        return {"status": "success", **data}
    except Exception as e:
        logger.error("build_step_node failed: %s", e)
        return {
            "status": "error",
            "intent": "Unknown step",
            "visual_cue": "",
            "action_type": "click",
            "target_description": click_context or "Unknown element",
            "input_value": None,
            "stores_to": None,
            "verification_cue": "Page state changes",
            "confidence_threshold": 0.82,
        }


async def store_workflow(workflow_id: str, user_id: str, steps: str) -> Dict[str, Any]:
    """
    Persist a finalized workflow to Firestore.

    Args:
        workflow_id: Unique identifier for the workflow.
        user_id: The user who owns this workflow.
        steps: JSON string of the list of StepNode dicts.

    Returns:
        Dict with status and workflow_id.
    """
    import json
    try:
        steps_list = json.loads(steps) if isinstance(steps, str) else steps
        workflow_doc = {
            "workflow_id": workflow_id,
            "user_id": user_id,
            "steps": steps_list,
            "status": "saved",
        }
        wid = await firestore_client.save_workflow(workflow_doc)
        return {"status": "success", "workflow_id": wid}
    except Exception as e:
        logger.error("store_workflow failed: %s", e)
        return {"status": "error", "error": str(e)}


async def load_workflow(workflow_id: str, user_id: str) -> Dict[str, Any]:
    """
    Load a workflow from Firestore.

    Args:
        workflow_id: The unique workflow identifier.
        user_id: The owner's user ID.

    Returns:
        Dict with status and workflow data (steps list, metadata).
    """
    try:
        doc = await firestore_client.load_workflow(workflow_id, user_id)
        if not doc:
            return {"status": "error", "error": "Workflow not found"}
        return {"status": "success", **doc}
    except Exception as e:
        logger.error("load_workflow failed: %s", e)
        return {"status": "error", "error": str(e)}


async def check_verification(
    screenshot_b64: str,
    verification_cue: str,
) -> Dict[str, Any]:
    """
    Verify that a workflow step's expected outcome is visible in the screenshot.

    Args:
        screenshot_b64: Base64-encoded PNG of the current page state.
        verification_cue: Description of what visual change should have occurred.

    Returns:
        Dict with keys: verified (bool), confidence (float), observation (str).
    """
    try:
        result = await gemini_client.check_verification(
            screenshot_b64=screenshot_b64,
            verification_cue=verification_cue,
        )
        return {"status": "success", **result}
    except Exception as e:
        logger.error("check_verification failed: %s", e)
        return {
            "status": "error",
            "verified": False,
            "confidence": 0.0,
            "observation": str(e),
        }


# ── Agent Definition ──────────────────────────────────────────

AGENT_INSTRUCTION = """
You are USERS, an intelligent workflow automation agent. Your job is to execute
browser-based workflows by analyzing screenshots and controlling the browser
purely through visual understanding — never through DOM inspection.

For each workflow step you must:
1. Call analyze_screenshot with the current screenshot and step details.
2. If confidence >= the step's threshold (typically 0.82): return an ActionCommand.
3. If confidence < threshold: ask the user a plain-English recovery question.
4. After the action executes, call check_verification to confirm the expected change.
5. If verification fails: retry up to 2 times, then escalate to recovery.

Rules:
- NEVER reference CSS selectors, XPaths, or DOM element IDs in your reasoning.
- Always describe elements by their visual appearance (color, label, position).
- Recovery questions must be plain English, e.g.:
  "I see two buttons that could be Submit. Which should I click — the blue one at the top or the grey one at the bottom?"
- Use normalized coordinates (0.0 to 1.0) for all x/y values.
"""

_users_agent: LlmAgent | None = None
_runner: Runner | None = None
_session_service: InMemorySessionService | None = None


def get_agent() -> LlmAgent:
    global _users_agent
    if _users_agent is None:
        _users_agent = LlmAgent(
            name="users_workflow_agent",
            model="gemini-2.0-flash",
            instruction=AGENT_INSTRUCTION,
            tools=[
                analyze_screenshot,
                build_step_node,
                store_workflow,
                load_workflow,
                check_verification,
            ],
        )
    return _users_agent


def get_runner() -> Runner:
    global _runner, _session_service
    if _runner is None:
        _session_service = InMemorySessionService()
        _runner = Runner(
            agent=get_agent(),
            app_name="users",
            session_service=_session_service,
        )
    return _runner


# ── High-level agent orchestration helpers ────────────────────

async def agent_finalize_workflow(steps: list[dict], workflow_name: str) -> dict:
    """
    Use Gemini (directly, not via ADK loop) to clean up steps and generate summary.
    The ADK agent is used for execute-time orchestration; finalization uses Gemini directly
    for a single-pass cleanup without needing a multi-turn conversation.
    """
    try:
        result = await gemini_client.finalize_workflow(steps)
        cleaned_steps = result.get("steps", steps)
        summary = result.get("summary", f"Workflow: {workflow_name}")
        return {"steps": cleaned_steps, "summary": summary}
    except Exception as e:
        logger.error("agent_finalize_workflow failed: %s", e)
        return {"steps": steps, "summary": f"Workflow: {workflow_name}"}


async def agent_execute_step(
    execution_id: str,
    step: dict,
    screenshot_b64: str,
    retry_context: str = "",
) -> dict:
    """
    Run the ADK agent for a single execution step.
    Returns: { action, recovery_needed, recovery_question, confidence, intent }
    """
    from google.genai import types as genai_types

    runner = get_runner()
    session_service = _session_service

    session_id = f"exec_{execution_id}_{step.get('step_id', 0)}"

    # Ensure session exists
    existing = await session_service.get_session(
        app_name="users", user_id="system", session_id=session_id
    )
    if existing is None:
        await session_service.create_session(
            app_name="users", user_id="system", session_id=session_id
        )

    intent = step.get("intent", "")
    visual_cue = step.get("visual_cue", "")
    target_description = step.get("target_description", "")
    action_type = step.get("action_type", "click")
    threshold = step.get("confidence_threshold", 0.82)
    step_index = step.get("step_id", 0)

    # Build the prompt message for the agent
    context = retry_context or ""
    message_text = (
        f"Execute step {step_index}. Intent: {intent}. "
        f"Visual cue: {visual_cue}. Target: {target_description}. "
        f"Action type: {action_type}. Confidence threshold: {threshold}. "
        f"{'Additional context from user: ' + context if context else ''}"
        f"\n\nCall analyze_screenshot with the provided screenshot to locate the element."
    )

    # Construct a genai Content message
    new_message = genai_types.Content(
        role="user",
        parts=[genai_types.Part(text=message_text)]
    )

    # Run agent turn — ADK orchestrates tool calls automatically
    try:
        async for event in runner.run_async(
            user_id="system",
            session_id=session_id,
            new_message=new_message,
        ):
            if hasattr(event, 'is_final_response') and event.is_final_response():
                pass  # Agent completed its turn
    except Exception as e:
        logger.error("ADK runner error: %s", e)
        # Fall back to direct Gemini call

    # Always use direct structured Gemini call for reliable JSON output
    return await _direct_locate_step(step, screenshot_b64, step_index, threshold)


async def _direct_locate_step(step: dict, screenshot_b64: str, step_index: int, threshold: float) -> dict:
    """
    Directly call Gemini to locate the element (fallback + primary path for structured output).
    """
    intent = step.get("intent", "")
    visual_cue = step.get("visual_cue", "")
    target_description = step.get("target_description", "")
    action_type = step.get("action_type", "click")
    input_value = step.get("input_value")

    try:
        location = await gemini_client.locate_element(
            screenshot_b64=screenshot_b64,
            step_index=step_index,
            intent=intent,
            visual_cue=visual_cue,
            target_description=target_description,
        )
    except Exception as e:
        logger.error("locate_element failed: %s", e)
        return {
            "action": None,
            "recovery_needed": True,
            "recovery_question": f"I couldn't analyze the screen ({e}). How should I proceed?",
            "confidence": 0.0,
            "intent": intent,
        }

    confidence = float(location.get("confidence", 0.0))
    found = location.get("found", False)
    x = float(location.get("x", 0.5))
    y = float(location.get("y", 0.5))
    recovery_question = location.get("recovery_question")

    if not found or confidence < threshold:
        return {
            "action": None,
            "recovery_needed": True,
            "recovery_question": recovery_question or (
                f"I'm not confident I found the right element for: {intent}. "
                f"Can you describe what I should click?"
            ),
            "confidence": confidence,
            "intent": intent,
        }

    # Build action command
    action = {
        "type": action_type,
        "x": x,
        "y": y,
        "value": input_value,
        "scroll_direction": None,
    }

    if action_type == "navigate":
        action["type"] = "navigate"
        action["value"] = input_value or ""
        action["x"] = None
        action["y"] = None

    return {
        "action": action,
        "recovery_needed": False,
        "recovery_question": None,
        "confidence": confidence,
        "intent": intent,
    }
