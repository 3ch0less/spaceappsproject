# Lumasphere: one container serves the API, the sky-tile proxy and the frontend.
#   docker build -t lumasphere .
#   docker run -p 8000:8000 -v lumasphere-cache:/data lumasphere
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000 \
    LUMASPHERE_CACHE_DIR=/data \
    LUMASPHERE_CACHE_GB=5

WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install -r backend/requirements.txt

COPY backend/ backend/
COPY frontend/ frontend/

# Run as an unprivileged user; /data holds the tile/time-lapse cache (mount a volume there to keep it).
RUN useradd --create-home --uid 10001 app && mkdir -p /data && chown app:app /data
USER app
VOLUME ["/data"]

WORKDIR /app/backend
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/api/health', timeout=4)"

# One worker on purpose: the caches and in-flight download de-duplication live in the process.
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*' --timeout-keep-alive 30 --log-level info"]
