FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

WORKDIR /app

COPY . /app
RUN uv sync --frozen --package db-mcp-server

ENV MCP_TRANSPORT=http
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=8080
ENV MCP_PATH=/mcp

EXPOSE 8080

CMD ["uv", "run", "db-mcp-server"]
