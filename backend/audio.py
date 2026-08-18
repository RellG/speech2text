"""ffmpeg-backed audio helpers for splitting long recordings.

Google's synchronous Speech v2 `Recognize` refuses anything over 60 seconds
("Audio can be of a maximum of 60 seconds."), so longer input is cut into
sub-limit pieces here and transcribed one piece at a time.

Cuts are placed inside detected silences rather than at fixed offsets, so a
boundary lands in a natural pause instead of the middle of a word.
"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger("stt.audio")

# ffmpeg writes silencedetect results to stderr as pairs of these.
_SILENCE_START = re.compile(r"silence_start:\s*(-?[\d.]+)")
_SILENCE_END = re.compile(r"silence_end:\s*(-?[\d.]+)")


class AudioToolError(RuntimeError):
    """Raised when ffmpeg/ffprobe is missing or fails on the given input."""


@dataclass(frozen=True)
class Segment:
    index: int
    start: float
    duration: float


def tools_available() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def _run(cmd: list[str], timeout: int = 600) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
    except FileNotFoundError as exc:
        raise AudioToolError("ffmpeg/ffprobe is not installed in this image") from exc
    except subprocess.TimeoutExpired as exc:
        raise AudioToolError(f"{cmd[0]} timed out after {timeout}s") from exc


def probe_duration(path: Path) -> float:
    """Duration in seconds, or 0.0 when the container has no usable metadata."""
    result = _run(
        [
            "ffprobe",
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        timeout=120,
    )
    raw = (result.stdout or "").strip()
    try:
        duration = float(raw)
    except ValueError:
        return 0.0
    # WebM from MediaRecorder often reports a nonsense or missing duration.
    return duration if duration > 0 else 0.0


def detect_silences(path: Path, noise_db: str = "-30dB", min_silence: float = 0.35) -> list[tuple[float, float]]:
    """Return (start, end) spans of detected silence, in seconds."""
    result = _run(
        [
            "ffmpeg", "-v", "info", "-nostdin",
            "-i", str(path),
            "-af", f"silencedetect=noise={noise_db}:d={min_silence}",
            "-f", "null", "-",
        ]
    )
    stderr = result.stderr or ""
    starts = [float(m) for m in _SILENCE_START.findall(stderr)]
    ends = [float(m) for m in _SILENCE_END.findall(stderr)]

    spans: list[tuple[float, float]] = []
    for i, start in enumerate(starts):
        if i < len(ends) and ends[i] > start:
            spans.append((start, ends[i]))
    return spans


def plan_segments(
    duration: float,
    silences: list[tuple[float, float]],
    max_len: float,
    min_len: float = 5.0,
) -> list[Segment]:
    """Split [0, duration) into pieces no longer than max_len.

    Each cut is placed at the midpoint of the last silence that falls inside the
    usable window, so boundaries land in pauses. When a stretch has no silence
    at all (continuous speech), it falls back to a hard cut at max_len.
    """
    if duration <= max_len:
        return [Segment(0, 0.0, duration)]

    cuts: list[float] = []
    position = 0.0

    while duration - position > max_len:
        window_start = position + min_len
        window_end = position + max_len

        chosen: float | None = None
        for start, end in silences:
            midpoint = (start + end) / 2.0
            if window_start <= midpoint <= window_end:
                chosen = midpoint  # keep the latest qualifying pause
        if chosen is None:
            chosen = window_end
            logger.debug("No silence in window; hard cut at %.2fs", chosen)

        cuts.append(chosen)
        position = chosen

    segments: list[Segment] = []
    start = 0.0
    for index, cut in enumerate(cuts):
        segments.append(Segment(index, start, cut - start))
        start = cut
    segments.append(Segment(len(cuts), start, duration - start))

    # Drop slivers produced by a pause sitting right at the end of the file.
    return [s for s in segments if s.duration > 0.25]


def extract_segment(source: Path, segment: Segment, destination: Path) -> Path:
    """Cut one segment out and normalise it to 16 kHz mono FLAC.

    FLAC is lossless and roughly a tenth the size of the equivalent WAV, which
    keeps every chunk far below the API's 10 MB inline ceiling.
    """
    result = _run(
        [
            "ffmpeg", "-v", "error", "-nostdin", "-y",
            "-ss", f"{segment.start:.3f}",
            "-t", f"{segment.duration:.3f}",
            "-i", str(source),
            "-ac", "1",
            "-ar", "16000",
            "-c:a", "flac",
            str(destination),
        ]
    )
    if result.returncode != 0 or not destination.exists() or destination.stat().st_size == 0:
        raise AudioToolError(
            f"ffmpeg failed to extract segment {segment.index}: {(result.stderr or '').strip()[:300]}"
        )
    return destination


def transcode_whole(source: Path, destination: Path) -> Path:
    """Normalise a whole file to 16 kHz mono FLAC (used to shrink big uploads)."""
    result = _run(
        [
            "ffmpeg", "-v", "error", "-nostdin", "-y",
            "-i", str(source),
            "-ac", "1",
            "-ar", "16000",
            "-c:a", "flac",
            str(destination),
        ]
    )
    if result.returncode != 0 or not destination.exists() or destination.stat().st_size == 0:
        raise AudioToolError(f"ffmpeg failed to transcode: {(result.stderr or '').strip()[:300]}")
    return destination
