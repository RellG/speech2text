# syntax=docker/dockerfile:1

# --------------------------------------------------------------------------- #
# Stage 1 — build the Vite/React bundle
# --------------------------------------------------------------------------- #
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend

# Install dependencies first so the layer caches across source-only changes.
COPY frontend/package.json ./
RUN npm install --no-audit --no-fund

COPY frontend/ ./
RUN npm run build


# --------------------------------------------------------------------------- #
# Stage 2 — runtime: FastAPI serving the API and the built frontend
#
# Base is debian:bookworm-slim rather than python:3.11-slim, because this Pi
# runs a 32-bit armhf userland: Docker resolves linux/arm/v7 images, and PyPI
# publishes no manylinux wheels for armv7l. Debian bookworm ships Python 3.11
# plus properly compiled armhf builds of grpcio and cryptography, so nothing
# has to be built from source. (piwheels does serve armv7l wheels, but its
# grpcio and pydantic-core wheels are missing their compiled extensions.)
# --------------------------------------------------------------------------- #
FROM debian:bookworm-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    FRONTEND_DIST=/app/frontend/dist

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        python3 \
        python3-pip \
        python3-grpcio \
        python3-cryptography \
    # ffmpeg splits recordings longer than the Speech API's 60s ceiling.
    # -nox/-nofree are not options here; the plain package pulls the codecs
    # needed to read webm/opus, m4a and flac.
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt backend/constraints.txt ./backend/

# --only-binary=:all: makes any accidental source build fail loudly here rather
# than silently requiring a compiler; the constraints file keeps pip from
# replacing the apt-provided grpcio/cryptography.
RUN pip3 install --break-system-packages --no-cache-dir --only-binary=:all: \
        -c backend/constraints.txt \
        -r backend/requirements.txt

COPY backend/ ./backend/
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Drop privileges — nothing here needs root at runtime.
RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
    CMD python3 -c "import urllib.request,sys; sys.exit(0) if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else sys.exit(1)"

CMD ["python3", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
