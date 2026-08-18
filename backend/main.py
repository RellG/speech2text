"""FastAPI backend for the homelab Speech-to-Text app.

Proxies audio uploads to Google Cloud Speech-to-Text v2 (chirp_2) and serves the
built React frontend as static files from the same process.
"""

import json
import logging
import os
import shutil
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from google.api_core import exceptions as google_exceptions
from google.api_core.client_options import ClientOptions
from google.cloud import speech_v2
from google.cloud.speech_v2.types import cloud_speech
from starlette.concurrency import run_in_threadpool

from . import audio

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logger = logging.getLogger("stt")

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

# Defaults to us-central1, not "global": the Speech v2 API reports
# 'The model "chirp_2" does not exist in the location named "global"'.
GCP_LOCATION = os.environ.get("GCP_LOCATION", "us-central1").strip() or "us-central1"
STT_MODEL = os.environ.get("STT_MODEL", "chirp_2").strip() or "chirp_2"
LANGUAGE_CODES = [
    code.strip()
    for code in os.environ.get("STT_LANGUAGE_CODES", "en-US").split(",")
    if code.strip()
] or ["en-US"]

# Hard server-side ceilings on synchronous Recognize, confirmed against the live
# API: inline audio must be under 10 MiB, and "Audio can be of a maximum of 60
# seconds." Longer input is split locally (see backend/audio.py) rather than
# going the BatchRecognize + GCS route, which would need a bucket and new IAM.
SYNC_LIMIT_SECONDS = 60.0
SYNC_LIMIT_BYTES = 10 * 1024 * 1024

# Target length per chunk, kept under the 60s ceiling with room for the cut to
# drift to a nearby pause.
CHUNK_SECONDS = float(os.environ.get("CHUNK_SECONDS", "50"))

# How long the browser is allowed to record in one take. Purely a UI cap now
# that the backend can chunk; raise it freely.
MAX_RECORDING_SECONDS = int(os.environ.get("MAX_RECORDING_SECONDS", "600"))

# Upload ceiling. Generous because long audio is chunked, but bounded so a
# runaway upload cannot fill the Pi's disk.
MAX_UPLOAD_BYTES = int(float(os.environ.get("MAX_UPLOAD_MB", "200")) * 1024 * 1024)

# Read the upload in modest pieces; the container is capped at 512 MB, so a
# large file must never be materialised in memory.
UPLOAD_CHUNK_BYTES = 1024 * 1024

ALLOWED_SUFFIXES = {".wav", ".mp3", ".m4a", ".mp4", ".flac", ".ogg", ".opus", ".webm", ".aac", ".amr"}

# Directory holding the built Vite bundle. In the Docker image the frontend is
# copied to /app/frontend/dist, which is the sibling of this file's parent.
FRONTEND_DIST = Path(
    os.environ.get("FRONTEND_DIST", Path(__file__).resolve().parent.parent / "frontend" / "dist")
)


def resolve_project_id() -> str:
    """Return the GCP project id from the environment or the service account key."""
    project_id = os.environ.get("GCP_PROJECT_ID", "").strip()
    if project_id:
        return project_id

    credentials_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    if credentials_path and Path(credentials_path).is_file():
        try:
            with open(credentials_path, "r", encoding="utf-8") as handle:
                key_project = json.load(handle).get("project_id", "")
            if key_project:
                logger.info("GCP_PROJECT_ID not set; using project_id from service account key")
                return key_project
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("Could not read project_id from credentials file: %s", exc)

    return ""


GCP_PROJECT_ID = resolve_project_id()

# --------------------------------------------------------------------------- #
# Google Cloud client
# --------------------------------------------------------------------------- #

_speech_client: speech_v2.SpeechClient | None = None


def get_speech_client() -> speech_v2.SpeechClient:
    """Lazily build a Speech v2 client, pinned to the right regional endpoint.

    Speech-to-Text v2 requires a regional API endpoint whenever the recognizer
    lives outside the `global` location; using the default endpoint with a
    regional recognizer fails with a confusing 400.
    """
    global _speech_client
    if _speech_client is None:
        client_options = None
        if GCP_LOCATION != "global":
            client_options = ClientOptions(api_endpoint=f"{GCP_LOCATION}-speech.googleapis.com")
        _speech_client = speech_v2.SpeechClient(client_options=client_options)
        logger.info(
            "Speech v2 client ready (project=%s location=%s model=%s)",
            GCP_PROJECT_ID or "<unresolved>",
            GCP_LOCATION,
            STT_MODEL,
        )
    return _speech_client


def recognize_bytes(content: bytes) -> str:
    """Send one sub-limit piece of audio and return its transcript text."""
    client = get_speech_client()
    response = client.recognize(request=build_recognize_request(content))
    return " ".join(
        result.alternatives[0].transcript.strip()
        for result in response.results
        if result.alternatives and result.alternatives[0].transcript.strip()
    ).strip()


def transcribe_file(source: Path, original_name: str) -> dict:
    """Transcribe a file of any length, splitting it when necessary.

    Runs entirely in a worker thread: the Speech client is blocking and ffmpeg
    is a subprocess, so neither belongs on the event loop.
    """
    size = source.stat().st_size
    duration = 0.0
    have_tools = audio.tools_available()

    if have_tools:
        duration = audio.probe_duration(source)

    # Fast path: short enough and small enough to send exactly as uploaded.
    # This is the proven path for typical takes, so leave it untouched.
    if duration <= SYNC_LIMIT_SECONDS and size <= SYNC_LIMIT_BYTES:
        logger.info("Direct recognize: %s (%.1fs, %d bytes)", original_name, duration, size)
        return {
            "transcript": recognize_bytes(source.read_bytes()),
            "duration_seconds": round(duration, 2) if duration else None,
            "chunks": 1,
        }

    if not have_tools:
        raise HTTPException(
            status_code=413,
            detail=(
                "This audio exceeds the 60 second / 10 MB limit of the synchronous "
                "Speech API, and ffmpeg is not available to split it."
            ),
        )

    with tempfile.TemporaryDirectory(prefix="stt-") as workdir:
        work = Path(workdir)

        # An unknown duration usually means a WebM stream with no seek index;
        # a re-encode gives ffprobe something it can measure.
        if duration <= 0:
            logger.info("No usable duration for %s; normalising first", original_name)
            source = audio.transcode_whole(source, work / "normalised.flac")
            duration = audio.probe_duration(source)
            if duration <= 0:
                raise HTTPException(
                    status_code=400, detail="Could not determine the duration of this audio."
                )

        # Still short, just physically large (e.g. high-bitrate WAV): shrinking
        # it to 16 kHz mono FLAC is enough, no splitting needed.
        if duration <= SYNC_LIMIT_SECONDS:
            shrunk = audio.transcode_whole(source, work / "shrunk.flac")
            if shrunk.stat().st_size <= SYNC_LIMIT_BYTES:
                logger.info("Transcoded %s to fit inline (%.1fs)", original_name, duration)
                return {
                    "transcript": recognize_bytes(shrunk.read_bytes()),
                    "duration_seconds": round(duration, 2),
                    "chunks": 1,
                }
            source = shrunk

        silences = audio.detect_silences(source)
        segments = audio.plan_segments(duration, silences, max_len=CHUNK_SECONDS)
        logger.info(
            "Chunking %s: %.1fs -> %d segments (%d silences detected)",
            original_name, duration, len(segments), len(silences),
        )

        pieces: list[str] = []
        for segment in segments:
            chunk_path = audio.extract_segment(source, segment, work / f"chunk-{segment.index:03d}.flac")
            chunk_size = chunk_path.stat().st_size
            if chunk_size > SYNC_LIMIT_BYTES:
                raise HTTPException(
                    status_code=400,
                    detail=f"Chunk {segment.index} came out at {chunk_size / 1_048_576:.1f} MB, over the API limit.",
                )

            text = recognize_bytes(chunk_path.read_bytes())
            logger.info(
                "  segment %d/%d (%.1fs @ %.1fs) -> %d chars",
                segment.index + 1, len(segments), segment.duration, segment.start, len(text),
            )
            if text:
                pieces.append(text)
            chunk_path.unlink(missing_ok=True)

        return {
            "transcript": " ".join(pieces).strip(),
            "duration_seconds": round(duration, 2),
            "chunks": len(segments),
        }


def build_recognize_request(content: bytes) -> cloud_speech.RecognizeRequest:
    config = cloud_speech.RecognitionConfig(
        auto_decoding_config=cloud_speech.AutoDetectDecodingConfig(),
        language_codes=LANGUAGE_CODES,
        model=STT_MODEL,
        features=cloud_speech.RecognitionFeatures(
            enable_automatic_punctuation=True,
        ),
    )
    return cloud_speech.RecognizeRequest(
        recognizer=f"projects/{GCP_PROJECT_ID}/locations/{GCP_LOCATION}/recognizers/_",
        config=config,
        content=content,
    )


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #

app = FastAPI(
    title="Homelab Speech-to-Text",
    description="FastAPI + Google Cloud Speech-to-Text v2 (chirp_2)",
    version="1.0.0",
)

# Only relevant for `npm run dev` on port 5173; production serves same-origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/api/config")
async def config() -> dict:
    """Non-secret runtime configuration, surfaced in the UI status bar."""
    return {
        "status": "ok" if GCP_PROJECT_ID else "unconfigured",
        "project_configured": bool(GCP_PROJECT_ID),
        "location": GCP_LOCATION,
        "model": STT_MODEL,
        "language_codes": LANGUAGE_CODES,
        "max_upload_bytes": MAX_UPLOAD_BYTES,
        # The UI reads these so the recorder cap and upload limit have a single
        # source of truth on the backend.
        "max_recording_seconds": MAX_RECORDING_SECONDS,
        "chunk_seconds": CHUNK_SECONDS,
        "chunking_available": audio.tools_available(),
    }


@app.post("/api/transcribe")
async def transcribe(file: UploadFile = File(...)) -> dict:
    if not GCP_PROJECT_ID:
        raise HTTPException(
            status_code=500,
            detail=(
                "GCP project is not configured. Set GCP_PROJECT_ID in .env "
                "or mount a service account key at GOOGLE_APPLICATION_CREDENTIALS."
            ),
        )

    filename = file.filename or "recording"
    suffix = Path(filename).suffix.lower()
    if suffix and suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type '{suffix}'. Allowed: {', '.join(sorted(ALLOWED_SUFFIXES))}",
        )

    # Stream the upload to disk rather than into memory: with chunking enabled
    # an upload can be far larger than the container's 512 MB cap.
    tmp_dir = tempfile.mkdtemp(prefix="stt-upload-")
    tmp_path = Path(tmp_dir) / f"upload{suffix or '.bin'}"
    written = 0
    try:
        with open(tmp_path, "wb") as sink:
            while piece := await file.read(UPLOAD_CHUNK_BYTES):
                written += len(piece)
                if written > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            f"Upload exceeds the {MAX_UPLOAD_BYTES // 1_048_576} MB limit."
                        ),
                    )
                sink.write(piece)
        await file.close()

        if written == 0:
            raise HTTPException(status_code=400, detail="Uploaded file is empty.")

        try:
            # Blocking Speech client plus ffmpeg subprocesses — keep both off
            # the event loop.
            result = await run_in_threadpool(transcribe_file, tmp_path, filename)
        except audio.AudioToolError as exc:
            logger.exception("Audio processing failed")
            raise HTTPException(status_code=500, detail=f"Audio processing failed: {exc}") from exc
    except HTTPException:
        raise
    except google_exceptions.InvalidArgument as exc:
        logger.warning("Speech API rejected the request: %s", exc.message)
        raise HTTPException(status_code=400, detail=f"Speech API rejected the audio: {exc.message}") from exc
    except google_exceptions.PermissionDenied as exc:
        logger.error("Permission denied from Speech API: %s", exc.message)
        raise HTTPException(
            status_code=502,
            detail=(
                "Permission denied by Google Cloud. Confirm the Speech-to-Text API is enabled "
                f"and the service account has roles/speech.client. ({exc.message})"
            ),
        ) from exc
    except google_exceptions.NotFound as exc:
        logger.error("Recognizer/location not found: %s", exc.message)
        raise HTTPException(
            status_code=502,
            detail=(
                f"Recognizer not found for location '{GCP_LOCATION}'. The model "
                f"'{STT_MODEL}' may not be available there. ({exc.message})"
            ),
        ) from exc
    except google_exceptions.GoogleAPICallError as exc:
        logger.exception("Speech API call failed")
        raise HTTPException(status_code=502, detail=f"Speech API error: {exc.message}") from exc
    except Exception as exc:  # noqa: BLE001 - surface auth/transport failures to the UI
        logger.exception("Unexpected transcription failure")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {exc}") from exc
    finally:
        # Always clear the upload, including on every error path above.
        shutil.rmtree(tmp_dir, ignore_errors=True)

    transcript = result["transcript"]
    logger.info(
        "Transcribed %s (%d bytes, %s, %d chunk(s)) -> %d chars",
        filename, written, f"{result['duration_seconds']}s" if result["duration_seconds"] else "unknown length",
        result["chunks"], len(transcript),
    )

    return {
        "status": "success",
        "filename": filename,
        "transcript": transcript,
        "duration_seconds": result["duration_seconds"],
        "chunks": result["chunks"],
    }


# --------------------------------------------------------------------------- #
# Static frontend (mounted last so /api/* keeps priority)
# --------------------------------------------------------------------------- #

if FRONTEND_DIST.is_dir():
    assets_dir = FRONTEND_DIST / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str) -> FileResponse:
        """Serve built files, falling back to index.html for client-side routes."""
        candidate = (FRONTEND_DIST / full_path).resolve()
        if (
            full_path
            and FRONTEND_DIST.resolve() in candidate.parents
            and candidate.is_file()
        ):
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")

    logger.info("Serving frontend from %s", FRONTEND_DIST)
else:
    logger.warning("Frontend bundle not found at %s - API only", FRONTEND_DIST)

    @app.get("/", include_in_schema=False)
    async def missing_frontend() -> dict:
        return {
            "status": "api-only",
            "detail": f"No built frontend at {FRONTEND_DIST}. Run 'npm run build' in frontend/.",
        }
