"""
Pydantic data models for USERS backend.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


# ── Step / Workflow graph ──────────────────────────────────────

class StepNode(BaseModel):
    step_id: int
    intent: str = ""
    visual_cue: str = ""
    narration_hint: str = ""
    action_type: str = "click"  # click | type | navigate | scroll | extract_value
    target_description: str = ""
    input_value: Optional[str] = None
    stores_to: Optional[str] = None
    verification_cue: str = ""
    confidence_threshold: float = 0.82


class WorkflowGraph(BaseModel):
    workflow_id: str
    workflow_name: str
    user_id: str
    steps: list[StepNode] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_run: Optional[datetime] = None
    run_count: int = 0
    status: str = "recording"  # recording | saved


# ── Action Commands (returned to extension) ───────────────────

class ActionCommand(BaseModel):
    type: str                          # click | type | navigate | scroll
    x: Optional[float] = None         # normalized 0-1
    y: Optional[float] = None         # normalized 0-1
    value: Optional[str] = None       # for type / navigate
    scroll_direction: Optional[str] = None  # up | down | left | right


# ── Execution step state ──────────────────────────────────────

class ExecutionStep(BaseModel):
    step_index: int
    intent: str
    status: str = "pending"  # pending | executing | done | recovering


# ── API request/response models ───────────────────────────────

class TeachStartRequest(BaseModel):
    workflow_name: str
    user_id: str


class TeachStartResponse(BaseModel):
    session_id: str


class TeachStepRequest(BaseModel):
    session_id: str
    screenshot_b64: str
    transcript_segment: str = ""
    click_context: str = ""
    step_index: int = 0


class TeachStepResponse(BaseModel):
    step_node: StepNode
    steps_captured: int


class TeachFinishRequest(BaseModel):
    session_id: str


class TeachFinishResponse(BaseModel):
    workflow_id: str
    step_count: int
    summary: str


class WorkflowListItem(BaseModel):
    workflow_id: str
    workflow_name: str
    step_count: int
    last_run: Optional[datetime] = None
    run_count: int = 0


class WorkflowListResponse(BaseModel):
    workflows: list[WorkflowListItem]


class ExecuteStartRequest(BaseModel):
    workflow_id: str
    user_id: str


class ExecuteStartResponse(BaseModel):
    execution_id: str
    first_step: Optional[ExecutionStep] = None


class ExecuteStepRequest(BaseModel):
    execution_id: str
    step_index: int
    current_screenshot_b64: str


class ExecuteStepResponse(BaseModel):
    action: Optional[ActionCommand] = None
    recovery_needed: bool = False
    recovery_question: Optional[str] = None
    confidence: float = 0.0
    intent: str = ""


class ExecuteRecoverRequest(BaseModel):
    execution_id: str
    step_index: int
    resolution: str


class ExecuteRecoverResponse(BaseModel):
    action: ActionCommand


class ExecuteCompleteRequest(BaseModel):
    execution_id: str


class ExecuteCompleteResponse(BaseModel):
    success: bool = True
