# Homelab Speech-to-Text

Single-container speech-to-text for a Raspberry Pi (ARM64). FastAPI proxies audio to
Google Cloud Speech-to-Text v2 (`chirp_2`) and serves a React frontend styled as iOS
"clear glass" — so one Python process handles both the API and the UI, with no extra
web server eating memory on the Pi.

## Stack

| Layer     | Choice                                                            |
|-----------|-------------------------------------------------------------------|
| Backend   | FastAPI + `google-cloud-speech` v2, run by uvicorn                 |
| Frontend  | React 18 + Vite, Tailwind CSS, Framer Motion, lucide-react         |
| Delivery  | Multi-stage Docker build; static bundle served straight by FastAPI |

## Layout

```text
.
├── backend/
│   ├── main.py           # API + static serving
│   └── requirements.txt
├── frontend/
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   └── src/
│       ├── App.jsx
│       ├── main.jsx
│       ├── index.css
│       ├── lib/utils.js
│       └── components/
│           ├── GlassCard.jsx
│           ├── MicRecorder.jsx
│           ├── FileUploader.jsx
│           ├── TranscriptViewer.jsx
│           └── Toast.jsx
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```

## Setup

1. **Service account key.** Put the JSON key at `./gcp-key.json`. It needs the
   Speech-to-Text API enabled on the project and `roles/speech.client` on the
   service account.

2. **Environment.**

   ```bash
   cp .env.example .env
   # then set GCP_PROJECT_ID (or leave blank to reuse the key's project_id)
   ```

3. **Run.**

   ```bash
   docker compose up -d --build
   ```

4. Open **`https://<pi-ip>`** (Caddy terminates TLS; plain HTTP redirects to it).

## HTTPS, and why it is not optional

Browsers only expose `getUserMedia()` and `navigator.clipboard` in a **secure
context** — HTTPS or `localhost`. Served over plain HTTP from a LAN address, the
record button is inert on every device except the Pi itself. So a Caddy sidecar
terminates TLS using its own internal CA.

Install the root certificate once per device and the app is fully trusted, with
no warning to click through:

```bash
scp reynoldshomelab@raspberrypi:~/speech2text/caddy-root-ca.crt .
```

| Device            | How to install                                                                 |
|-------------------|--------------------------------------------------------------------------------|
| macOS             | Double-click → Keychain Access → System → set to **Always Trust**               |
| Windows           | Double-click → Install Certificate → Local Machine → *Trusted Root CAs*         |
| iOS / iPadOS      | AirDrop or email it → Settings → *Profile Downloaded* → Install, then **Settings → General → About → Certificate Trust Settings** → enable it (this second step is required and easy to miss) |
| Android           | Settings → Security → Encryption & credentials → Install a certificate → **CA certificate** |
| Linux (Debian)    | `sudo cp caddy-root-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates` |
| Firefox           | Has its own store: Settings → Privacy & Security → Certificates → View Certificates → Import |

Skipping the install still works — accept the browser warning and the origin is
treated as secure, so the microphone functions. The certificate install just
removes the warning.

Reachable names, all covered by the certificate: `https://192.168.4.129`,
`https://raspberrypi`, `https://raspberrypi.local`, `https://localhost`.

Plain HTTP is bound to `127.0.0.1:8000` only, so it stays available through an
SSH tunnel without being exposed on the LAN:

```bash
ssh -L 8000:localhost:8000 reynoldshomelab@raspberrypi   # then http://localhost:8000
```

## API

| Method | Path              | Purpose                                                  |
|--------|-------------------|----------------------------------------------------------|
| GET    | `/api/health`     | `{"status": "ok"}`                                       |
| GET    | `/api/config`     | Non-secret runtime config for the UI status pill          |
| POST   | `/api/transcribe` | Multipart `file` → `{status, filename, transcript}`       |

```bash
curl -F "file=@sample.wav" http://localhost:8000/api/transcribe
```

## Constraints worth knowing

- **Recordings of any length work, via local chunking.** The v2 *synchronous*
  `Recognize` call hard-caps at 60 seconds (`Audio can be of a maximum of 60
  seconds.`) and 10 MB. Rather than take on a GCS bucket and `BatchRecognize`,
  the backend splits longer audio itself — see below.
- **Microphone needs a secure context** — handled by the Caddy sidecar above.
  Two gotchas worth knowing: editing `Caddyfile` needs
  `docker compose restart caddy` (it is a bind mount, so `up -d` reports
  "Running" and reloads nothing), and the `caddy_data` volume must persist or
  each restart mints a new CA and every device stops trusting the app.
- **`chirp_2` is not available in `global`.** Verified against the live API — it
  answers `The model "chirp_2" does not exist in the location named "global"`.
  Use a real region; `us-central1` is confirmed working and is the default. The
  backend automatically switches to the `<location>-speech.googleapis.com`
  endpoint whenever `GCP_LOCATION` is not `global`, which the v2 API requires.
- **The service account needs `roles/speech.client`.** `roles/speech.serviceAgent`
  looks plausible but is the Google-managed service-agent role and does *not*
  grant `speech.recognizers.recognize`.
- **The container runs as uid 1000** (`user:` in `docker-compose.yml`) so it can
  read a `chmod 600` `gcp-key.json` owned by the host user, rather than needing
  the credential to be world-readable. Change it if your key has a different owner.

## Long recordings

Audio over the API's 60-second ceiling is split locally by `backend/audio.py`
and reassembled, so the app accepts takes of any length with no extra GCP setup.

How a cut is chosen matters: fixed-offset splitting slices words in half. So
ffmpeg's `silencedetect` finds pauses first, and each boundary is placed at the
**midpoint of the last silence** inside the allowed window, falling back to a
hard cut only where there is no pause at all. Pieces are normalised to 16 kHz
mono FLAC (comfortably under the 10 MB inline limit) and transcribed in order.

Measured on the Pi:

| Input      | Chunks | Wall time | Result                                  |
|------------|--------|-----------|-----------------------------------------|
| 3.8s wav   | 1      | ~1.5s     | direct path, unchanged                   |
| 90s wav    | 2      | ~5.9s     | previously rejected with HTTP 400        |
| 260s wav   | 6      | ~17.5s    | all 40 sentences, exactly 680 words      |

That last row is the real check — the source repeated a fixed 17-word sentence
40 times, and the reassembled transcript contained exactly 680 words, so nothing
was dropped or duplicated at any of the six boundaries.

Tunable in `.env` (`MAX_RECORDING_SECONDS`, `CHUNK_SECONDS`, `MAX_UPLOAD_MB`).
The UI reads these from `/api/config`, so the recorder cap and upload limit have
a single source of truth on the backend. Uploads stream to a temp file rather
than into memory, and peak RSS stayed at ~36 MB against the 512 MB cap.

## Raspberry Pi specifics

This Pi runs a **64-bit kernel with a 32-bit armhf userland** (`uname -m` says
`aarch64`, `dpkg --print-architecture` says `armhf`), which drives two things:

- **Docker resolves `linux/arm/v7` images, and PyPI has no manylinux wheels for
  armv7l.** So the runtime stage is `debian:bookworm-slim` (Python 3.11 + working
  armhf builds of `grpcio` and `cryptography` from apt) rather than
  `python:3.11-slim`, and pip runs with `--only-binary=:all:` so a missing wheel
  fails the build instead of silently needing a compiler. Pulling `arm64` images
  does not help — they download but will not execute.
- **piwheels is deliberately not used.** It does serve armv7l wheels, but its
  `grpcio` and `pydantic-core` builds ship without their compiled extensions
  (`ImportError: cannot import name 'cygrpc'`), and because piwheels wheels carry
  a more specific platform tag than PyPI's universal ones, pip prefers them.

The installed Docker daemon (20.10, API 1.41) is older than the Compose plugin
expects, so Compose commands need:

```bash
export DOCKER_API_VERSION=1.41
docker compose up -d --build
```

Without it Compose fails with `client version 1.52 is too new`.

## Local development

Two processes, with Vite proxying `/api` to the backend:

```bash
# terminal 1
pip install -r backend/requirements.txt
export GOOGLE_APPLICATION_CREDENTIALS="$PWD/gcp-key.json"
uvicorn backend.main:app --reload --port 8000

# terminal 2
cd frontend && npm install && npm run dev   # http://localhost:5173
```

## Design notes

Dark-first iOS glass: an ambient gradient with slow-drifting colour blobs sits behind
translucent, heavily blurred panels with hairline borders. Light mode uses a denser
glass fill (`bg-white/70`) because the usual `white/10` leaves body text well under
the 4.5:1 contrast floor.

Motion is spring-based — 0.96 tap scale, −2px hover lift, a mic aura driven by real
RMS input level from an `AnalyserNode`, and a word-by-word blur-in on transcript
reveal. Every animation is gated behind `useReducedMotion()`, with a CSS
`prefers-reduced-motion` block as backstop.
