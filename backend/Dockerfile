# Scrub+ backend for a Nebius Serverless Endpoint (CPU). Build from the repo root:
#   docker build -f backend/Dockerfile -t scrub-backend .
FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /srv
COPY --from=ghcr.io/astral-sh/uv:0.11.3 /uv /usr/local/bin/uv
COPY backend/pyproject.toml backend/uv.lock backend/
RUN cd backend && uv sync --frozen --no-dev
COPY backend/app backend/app
COPY shared shared
COPY prompts prompts
ENV METRICS_DIR=/tmp/metrics
EXPOSE 8000
WORKDIR /srv/backend
CMD ["uv", "run", "--no-dev", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
