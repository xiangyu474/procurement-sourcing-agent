# Container image for the Python sourcing agent.
# The image is built by Cloudflare's hosted build environment, so no local
# Docker installation is required on the development machine.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src

RUN pip install --no-cache-dir .

EXPOSE 8000

CMD ["uvicorn", "procurement_agent.api.app:app", "--host", "0.0.0.0", "--port", "8000"]
