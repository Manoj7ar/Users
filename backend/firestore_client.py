"""
Firestore client — all reads/writes for USERS workflow data.
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime
from typing import Any, Optional

from google.cloud import firestore

logger = logging.getLogger(__name__)

# ── Client singleton ───────────────────────────────────────────
_db: firestore.AsyncClient | None = None


def get_db() -> firestore.AsyncClient:
    global _db
    if _db is None:
        project = os.getenv("GOOGLE_CLOUD_PROJECT")
        database = os.getenv("FIRESTORE_DATABASE", "(default)")
        _db = firestore.AsyncClient(project=project, database=database)
    return _db


# ── Teach session helpers ─────────────────────────────────────

async def create_session(workflow_name: str, user_id: str) -> str:
    """Create a new recording session. Returns session_id."""
    db = get_db()
    session_id = str(uuid.uuid4())
    doc = {
        "session_id": session_id,
        "workflow_name": workflow_name,
        "user_id": user_id,
        "status": "recording",
        "steps": [],
        "created_at": datetime.utcnow().isoformat(),
    }
    await db.collection("sessions").document(session_id).set(doc)
    return session_id


async def append_step(session_id: str, step_node: dict) -> int:
    """Append a StepNode to a session. Returns updated step count."""
    db = get_db()
    ref = db.collection("sessions").document(session_id)
    doc = await ref.get()
    if not doc.exists:
        raise ValueError(f"Session {session_id} not found")

    data = doc.to_dict()
    steps: list = data.get("steps", [])
    steps.append(step_node)
    await ref.update({"steps": steps})
    return len(steps)


async def get_session(session_id: str) -> Optional[dict]:
    db = get_db()
    doc = await db.collection("sessions").document(session_id).get()
    if not doc.exists:
        return None
    return doc.to_dict()


async def set_session_status(session_id: str, status: str) -> None:
    db = get_db()
    await db.collection("sessions").document(session_id).update({"status": status})


# ── Workflow helpers ──────────────────────────────────────────

async def save_workflow(workflow: dict) -> str:
    """Save a finalized workflow. Returns workflow_id."""
    db = get_db()
    workflow_id = workflow.get("workflow_id") or str(uuid.uuid4())
    workflow["workflow_id"] = workflow_id
    user_id = workflow.get("user_id", "unknown")
    await db.collection("workflows").document(user_id).collection("items").document(workflow_id).set(workflow)
    return workflow_id


async def load_workflow(workflow_id: str, user_id: str) -> Optional[dict]:
    db = get_db()
    doc = await (
        db.collection("workflows")
        .document(user_id)
        .collection("items")
        .document(workflow_id)
        .get()
    )
    if not doc.exists:
        return None
    return doc.to_dict()


async def list_workflows(user_id: str) -> list[dict]:
    db = get_db()
    col_ref = db.collection("workflows").document(user_id).collection("items")
    docs = col_ref.stream()
    results = []
    async for doc in docs:
        results.append(doc.to_dict())
    return results


async def update_workflow_run(workflow_id: str, user_id: str) -> None:
    db = get_db()
    ref = (
        db.collection("workflows")
        .document(user_id)
        .collection("items")
        .document(workflow_id)
    )
    doc = await ref.get()
    if doc.exists:
        data = doc.to_dict()
        run_count = data.get("run_count", 0) + 1
        await ref.update({
            "last_run": datetime.utcnow().isoformat(),
            "run_count": run_count
        })


# ── Execution session helpers ─────────────────────────────────

async def create_execution(execution_id: str, workflow_id: str, user_id: str, total_steps: int) -> None:
    db = get_db()
    doc = {
        "execution_id": execution_id,
        "workflow_id": workflow_id,
        "user_id": user_id,
        "total_steps": total_steps,
        "step_index": 0,
        "status": "running",
        "recovery_data": {},
        "started_at": datetime.utcnow().isoformat(),
    }
    await db.collection("executions").document(execution_id).set(doc)


async def get_execution(execution_id: str) -> Optional[dict]:
    db = get_db()
    doc = await db.collection("executions").document(execution_id).get()
    if not doc.exists:
        return None
    return doc.to_dict()


async def update_execution(execution_id: str, updates: dict[str, Any]) -> None:
    db = get_db()
    await db.collection("executions").document(execution_id).update(updates)


async def store_recovery_resolution(execution_id: str, step_index: int, resolution: str) -> None:
    db = get_db()
    await db.collection("executions").document(execution_id).update({
        f"recovery_data.step_{step_index}": resolution
    })
