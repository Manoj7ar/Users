"""
USERS Backend — FastAPI application.
All endpoints for Teach, Execute, and Workflow management.
"""
from __future__ import annotations

import logging
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

import agent as users_agent
import firestore_client
import gemini_client
from models import (
    ActionCommand,
    ExecuteCompleteRequest,
    ExecuteCompleteResponse,
    ExecuteRecoverRequest,
    ExecuteRecoverResponse,
    ExecuteStartRequest,
    ExecuteStartResponse,
    ExecuteStepRequest,
    ExecuteStepResponse,
    ExecutionStep,
    StepNode,
    TeachFinishRequest,
    TeachFinishResponse,
    TeachStartRequest,
    TeachStartResponse,
    TeachStepRequest,
    TeachStepResponse,
    WorkflowListItem,
    WorkflowListResponse,
)

# ── Logging ────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# ── App Lifecycle ──────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("USERS backend starting up…")
    # Warm up Gemini model
    _ = gemini_client.get_model()
    # Warm up ADK agent
    _ = users_agent.get_agent()
    yield
    logger.info("USERS backend shutting down.")


app = FastAPI(
    title="USERS Backend",
    description="Visual workflow automation backend powered by Gemini 2.0 Flash + Google ADK",
    version="1.0.0",
    lifespan=lifespan,
)

# ── CORS ───────────────────────────────────────────────────────
# Allow all origins in development; restrict to extension origin in production.
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if "*" in ALLOWED_ORIGINS else ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Health check ───────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "service": "users-backend"}


# ── TEACH endpoints ────────────────────────────────────────────

@app.post("/teach/start", response_model=TeachStartResponse)
async def teach_start(req: TeachStartRequest):
    """Create a new recording session in Firestore."""
    try:
        session_id = await firestore_client.create_session(
            workflow_name=req.workflow_name,
            user_id=req.user_id,
        )
        logger.info("Teach session created: %s (%s)", session_id, req.workflow_name)
        return TeachStartResponse(session_id=session_id)
    except Exception as e:
        logger.error("teach_start error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/teach/step", response_model=TeachStepResponse)
async def teach_step(req: TeachStepRequest):
    """
    Process a single recorded step:
    1. Resize screenshot with Pillow
    2. Call Gemini 2.0 Flash to build a StepNode
    3. Append to Firestore session
    """
    try:
        # Build step node via Gemini
        step_data = await gemini_client.build_step_node(
            screenshot_b64=req.screenshot_b64,
            narration=req.transcript_segment,
            click_context=req.click_context,
        )

        step_node = StepNode(
            step_id=req.step_index,
            intent=step_data.get("intent", ""),
            visual_cue=step_data.get("visual_cue", ""),
            narration_hint=req.transcript_segment,
            action_type=step_data.get("action_type", "click"),
            target_description=step_data.get("target_description", ""),
            input_value=step_data.get("input_value"),
            stores_to=step_data.get("stores_to"),
            verification_cue=step_data.get("verification_cue", ""),
            confidence_threshold=float(step_data.get("confidence_threshold", 0.82)),
        )

        step_dict = step_node.model_dump()
        steps_captured = await firestore_client.append_step(req.session_id, step_dict)

        logger.info("Step %d captured for session %s", req.step_index, req.session_id)
        return TeachStepResponse(step_node=step_node, steps_captured=steps_captured)

    except Exception as e:
        logger.error("teach_step error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/teach/finish", response_model=TeachFinishResponse)
async def teach_finish(req: TeachFinishRequest):
    """
    Finalize a recording session:
    1. Load all steps from Firestore
    2. Use ADK agent to clean up and summarize
    3. Save as a WorkflowGraph
    """
    try:
        session = await firestore_client.get_session(req.session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")

        raw_steps = session.get("steps", [])
        workflow_name = session.get("workflow_name", "Untitled Workflow")
        user_id = session.get("user_id", "unknown")

        # ADK agent finalizes: cleans up steps, generates summary
        finalized = await users_agent.agent_finalize_workflow(raw_steps, workflow_name)
        clean_steps = finalized.get("steps", raw_steps)
        summary = finalized.get("summary", f"Automates: {workflow_name}")

        workflow_id = str(uuid.uuid4())
        workflow_doc = {
            "workflow_id": workflow_id,
            "workflow_name": workflow_name,
            "user_id": user_id,
            "steps": clean_steps,
            "step_count": len(clean_steps),
            "created_at": datetime.utcnow().isoformat(),
            "last_run": None,
            "run_count": 0,
            "status": "saved",
            "summary": summary,
        }

        saved_id = await firestore_client.save_workflow(workflow_doc)
        await firestore_client.set_session_status(req.session_id, "saved")

        logger.info("Workflow saved: %s (%d steps)", saved_id, len(clean_steps))
        return TeachFinishResponse(
            workflow_id=saved_id,
            step_count=len(clean_steps),
            summary=summary,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error("teach_finish error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


# ── WORKFLOW list ──────────────────────────────────────────────

@app.get("/workflows/{user_id}", response_model=WorkflowListResponse)
async def list_workflows(user_id: str):
    """Return all saved workflows for a user."""
    try:
        docs = await firestore_client.list_workflows(user_id)
        items = []
        for doc in docs:
            items.append(WorkflowListItem(
                workflow_id=doc.get("workflow_id", ""),
                workflow_name=doc.get("workflow_name", "Untitled"),
                step_count=doc.get("step_count", len(doc.get("steps", []))),
                last_run=_parse_dt(doc.get("last_run")),
                run_count=doc.get("run_count", 0),
            ))
        return WorkflowListResponse(workflows=items)
    except Exception as e:
        logger.error("list_workflows error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


# ── EXECUTE endpoints ──────────────────────────────────────────

@app.post("/execute/start", response_model=ExecuteStartResponse)
async def execute_start(req: ExecuteStartRequest):
    """
    Load a workflow from Firestore and initialize an execution session.
    Returns the execution_id and the first step.
    """
    try:
        workflow = await firestore_client.load_workflow(req.workflow_id, req.user_id)
        if not workflow:
            raise HTTPException(status_code=404, detail="Workflow not found")

        steps = workflow.get("steps", [])
        if not steps:
            raise HTTPException(status_code=400, detail="Workflow has no steps")

        execution_id = str(uuid.uuid4())
        await firestore_client.create_execution(
            execution_id=execution_id,
            workflow_id=req.workflow_id,
            user_id=req.user_id,
            total_steps=len(steps),
        )

        first_step = ExecutionStep(
            step_index=0,
            intent=steps[0].get("intent", ""),
            status="pending",
        )

        logger.info("Execution started: %s for workflow %s", execution_id, req.workflow_id)
        return ExecuteStartResponse(execution_id=execution_id, first_step=first_step)

    except HTTPException:
        raise
    except Exception as e:
        logger.error("execute_start error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/execute/step", response_model=ExecuteStepResponse)
async def execute_step(req: ExecuteStepRequest):
    """
    For the current step:
    1. Load the workflow step from the execution's workflow
    2. Call ADK agent (Gemini) to locate the target element
    3. Return action command or recovery request
    """
    try:
        execution = await firestore_client.get_execution(req.execution_id)
        if not execution:
            raise HTTPException(status_code=404, detail="Execution not found")

        workflow = await firestore_client.load_workflow(
            execution["workflow_id"], execution["user_id"]
        )
        if not workflow:
            raise HTTPException(status_code=404, detail="Workflow not found")

        steps = workflow.get("steps", [])
        if req.step_index >= len(steps):
            raise HTTPException(status_code=400, detail="Step index out of range")

        step = steps[req.step_index]

        # Get any recovery context stored for this step
        recovery_data = execution.get("recovery_data", {})
        retry_context = recovery_data.get(f"step_{req.step_index}", "")

        # Run ADK agent execution logic
        result = await users_agent.agent_execute_step(
            execution_id=req.execution_id,
            step=step,
            screenshot_b64=req.current_screenshot_b64,
            retry_context=retry_context,
        )

        # Update execution state
        await firestore_client.update_execution(req.execution_id, {
            "step_index": req.step_index,
        })

        action = None
        if result.get("action"):
            action = ActionCommand(**result["action"])

        return ExecuteStepResponse(
            action=action,
            recovery_needed=result.get("recovery_needed", False),
            recovery_question=result.get("recovery_question"),
            confidence=result.get("confidence", 0.0),
            intent=result.get("intent", step.get("intent", "")),
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error("execute_step error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/execute/recover", response_model=ExecuteRecoverResponse)
async def execute_recover(req: ExecuteRecoverRequest):
    """
    Store the user's recovery resolution and return the action to execute.
    """
    try:
        execution = await firestore_client.get_execution(req.execution_id)
        if not execution:
            raise HTTPException(status_code=404, detail="Execution not found")

        # Store the resolution for future retries
        await firestore_client.store_recovery_resolution(
            req.execution_id, req.step_index, req.resolution
        )

        workflow = await firestore_client.load_workflow(
            execution["workflow_id"], execution["user_id"]
        )
        if not workflow:
            raise HTTPException(status_code=404, detail="Workflow not found")

        steps = workflow.get("steps", [])
        if req.step_index >= len(steps):
            raise HTTPException(status_code=400, detail="Step index out of range")

        step = steps[req.step_index]

        # Re-run with the additional context from the user's resolution
        # We return a best-effort action based on the resolution text
        # In this simplified path, we trust the user's description
        action = _resolution_to_action(req.resolution, step)

        logger.info("Recovery resolved for step %d: %s", req.step_index, req.resolution)
        return ExecuteRecoverResponse(action=action)

    except HTTPException:
        raise
    except Exception as e:
        logger.error("execute_recover error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/execute/complete", response_model=ExecuteCompleteResponse)
async def execute_complete(req: ExecuteCompleteRequest):
    """Mark an execution as complete and update the workflow's last_run timestamp."""
    try:
        execution = await firestore_client.get_execution(req.execution_id)
        if execution:
            await firestore_client.update_execution(req.execution_id, {"status": "complete"})
            await firestore_client.update_workflow_run(
                execution["workflow_id"], execution["user_id"]
            )
        return ExecuteCompleteResponse(success=True)
    except Exception as e:
        logger.error("execute_complete error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


# ── Helpers ────────────────────────────────────────────────────

def _parse_dt(value) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value))
    except Exception:
        return None


def _resolution_to_action(resolution: str, step: dict) -> ActionCommand:
    """
    Convert a recovery resolution string to an ActionCommand.
    This is a best-effort heuristic — the resolution is typically
    something like "the blue button on the left" and will be used
    on the next /execute/step call with updated context.
    For immediate recovery, return the step's action type with
    default coordinates (0.5, 0.5 = center of screen).
    """
    action_type = step.get("action_type", "click")
    return ActionCommand(
        type=action_type if action_type in ("click", "type", "navigate", "scroll") else "click",
        x=0.5,
        y=0.5,
        value=step.get("input_value"),
        scroll_direction=None,
    )
