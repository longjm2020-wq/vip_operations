# Build with repository root as context. Source is pinned to the v2.2.0 commit.
FROM ghcr.io/astral-sh/uv:0.11.1 AS uv
FROM python:3.12-slim-bookworm AS builder
COPY --from=uv /uv /usr/local/bin/uv
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/deerflow
RUN git init . && git remote add origin https://github.com/bytedance/deer-flow.git \
    && git fetch --depth 1 origin 58fc5bd5b8e6ea46538e9481ba06ca2a46e14e2a \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "58fc5bd5b8e6ea46538e9481ba06ca2a46e14e2a"
WORKDIR /opt/deerflow/backend
RUN uv sync --locked --no-default-groups

FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libmagic1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 deerflow && useradd --uid 10001 --gid 10001 --no-create-home deerflow
COPY --from=builder /opt/deerflow/backend /opt/deerflow/backend
COPY --from=builder /opt/deerflow/LICENSE /opt/deerflow/LICENSE
COPY services/deerflow/start.py /opt/deerflow/start.py
COPY services/deerflow/erp_chat_model.py services/deerflow/test_erp_chat_model.py /opt/deerflow/backend/
ENV PATH=/opt/deerflow/backend/.venv/bin:$PATH \
    PYTHONPATH=/opt/deerflow/backend \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    LANG=C.UTF-8 LC_ALL=C.UTF-8 \
    DEER_FLOW_HOME=/data/deerflow DEER_FLOW_PROJECT_ROOT=/opt/deerflow \
    DEER_FLOW_CONFIG_PATH=/data/deerflow/config.json \
    DEER_FLOW_AUTH_DISABLED=0 PORT=8001
WORKDIR /opt/deerflow/backend
# Uses a loopback HTTP fixture only; no supplier credentials or paid requests.
RUN python test_erp_chat_model.py && rm test_erp_chat_model.py
# start.py initializes only its own volume directories, then drops root before
# importing the Gateway. There is no host socket, shell tool, or ERP volume.
EXPOSE 8001
CMD ["python", "/opt/deerflow/start.py"]
