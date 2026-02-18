"""
Google Cloud Speech-to-Text helpers.
Note: In this architecture the extension uses the Web Speech API for real-time
transcription during Teach Mode (no audio upload needed). This module is provided
for any server-side transcription needs (e.g. uploaded audio blobs in the future).
"""
from __future__ import annotations

import asyncio
import logging
import os

logger = logging.getLogger(__name__)


async def transcribe_audio_bytes(audio_bytes: bytes, sample_rate: int = 16000) -> str:
    """
    Transcribe raw LINEAR16 PCM audio bytes using Google Cloud Speech-to-Text.
    Returns the transcript string.
    """
    try:
        from google.cloud import speech  # type: ignore

        client = speech.SpeechAsyncClient()

        config = speech.RecognitionConfig(
            encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
            sample_rate_hertz=sample_rate,
            language_code="en-US",
            enable_automatic_punctuation=True,
        )

        audio = speech.RecognitionAudio(content=audio_bytes)

        response = await client.recognize(config=config, audio=audio)

        transcript = " ".join(
            result.alternatives[0].transcript
            for result in response.results
            if result.alternatives
        )
        return transcript.strip()

    except ImportError:
        logger.warning("google-cloud-speech not installed — skipping transcription")
        return ""
    except Exception as e:
        logger.error("Speech transcription error: %s", e)
        return ""


async def transcribe_audio_file(file_path: str) -> str:
    """Transcribe a local audio file (WAV/FLAC/MP3 etc.)."""
    with open(file_path, "rb") as f:
        audio_bytes = f.read()
    return await transcribe_audio_bytes(audio_bytes)
