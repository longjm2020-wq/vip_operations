"""Pinned DeerFlow Gateway startup for the ERP's private service connection."""

import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
from urllib.parse import urlsplit


def configuration(env):
    for name in ("DEER_FLOW_INTERNAL_AUTH_TOKEN", "DEER_FLOW_MODEL_PROXY_TOKEN", "AUTH_JWT_SECRET"):
        if not re.fullmatch(r"[a-fA-F0-9]{64}", env.get(name, "")):
            raise ValueError(f"{name} must be a distinct 32-byte hexadecimal secret")
    if len({env[name] for name in ("DEER_FLOW_INTERNAL_AUTH_TOKEN", "DEER_FLOW_MODEL_PROXY_TOKEN", "AUTH_JWT_SECRET")}) != 3:
        raise ValueError("DeerFlow service credentials must be distinct")
    if env.get("DEER_FLOW_AUTH_DISABLED", "0") != "0":
        raise ValueError("DeerFlow authentication cannot be disabled")
    base = env.get("ERP_API_BASE", "").rstrip("/")
    url = urlsplit(base)
    if url.username or url.password or url.query or url.fragment or url.path or not url.hostname:
        raise ValueError("ERP_API_BASE must be an origin without credentials or a path")
    if url.scheme != "https" and not (url.scheme == "http" and url.hostname.endswith(".railway.internal")):
        raise ValueError("ERP_API_BASE requires HTTPS or a Railway private origin")
    home = PurePosixPath(env.get("DEER_FLOW_HOME", "/data/deerflow"))
    if not home.is_absolute() or home == PurePosixPath("/"):
        raise ValueError("DEER_FLOW_HOME must be an absolute dedicated data directory")
    tools = [
        {"name": "web_search", "group": "web", "use": "deerflow.community.ddg_search.tools:web_search_tool", "max_results": 5},
        {"name": "web_fetch", "group": "web", "use": "deerflow.community.jina_ai.tools:web_fetch_tool"},
    ]
    for name, group in (("ls", "file:read"), ("read_file", "file:read"), ("glob", "file:read"), ("grep", "file:read"), ("write_file", "file:write"), ("str_replace", "file:write")):
        tools.append({"name": name, "group": group, "use": f"deerflow.sandbox.tools:{name}_tool"})
    return {
        "config_version": 63,
        "log_level": "info",
        "llm_call": {"retry_max_attempts": 1},
        "models": [{
            "name": "erp-default", "display_name": "网站智能服务", "model": "erp-default",
            "use": "langchain_openai:ChatOpenAI",
            "base_url": base + "/internal/deerflow/v1",
            "api_key": "$DEER_FLOW_MODEL_PROXY_TOKEN",
            "max_tokens": 8192, "timeout": 180, "max_retries": 0,
            "supports_vision": False, "supports_thinking": False,
        }],
        "tool_groups": [{"name": group} for group in ("web", "file:read", "file:write")],
        "tools": tools,
        "sandbox": {"use": "deerflow.sandbox.local:LocalSandboxProvider", "allow_host_bash": False, "mounts": []},
        "skills": {"path": str(home / "skills"), "container_path": "/mnt/skills"},
        "database": {"backend": "sqlite", "sqlite_dir": str(home / "data")},
        "run_events": {"backend": "db", "max_trace_content": 10240, "track_token_usage": True},
        "auth": {"local": {"allow_registration": False}},
        "memory": {"enabled": False},
        "recursion_limit": 40, "max_recursion_limit": 60,
        "subagents": {"max_total_per_run": 6, "max_turns": 25, "timeout_seconds": 600},
        "subagent_runtime": {"max_running": 2, "max_queued": 8, "admission_policy": "queue", "queue_timeout_seconds": 120},
        "token_budget": {"enabled": True, "max_tokens": 200000, "warn_threshold": 0.8, "hard_stop_threshold": 1.0},
        "token_usage": {"enabled": True},
        "lead_prompt_overlay": {"append": "使用中文向用户交付清楚、简洁的结果。按需分配研究、撰写和独立检查子任务。只引用实际工具结果，不把计划或口头承诺当作文件交付。当前环境支持公开研究与隔离的文本文件读写，不支持运行代码、操作网站业务或生成图片视频。"},
    }


def main():
    config = configuration(os.environ)
    os.umask(0o027)
    home = Path(os.environ.get("DEER_FLOW_HOME", "/data/deerflow"))
    for path in (home, home / "data", home / "skills", home / "skills" / "public"):
        path.mkdir(parents=True, exist_ok=True)
        if os.getuid() == 0:
            os.chown(path, 10001, 10001)
    target = home / "config.json"
    target.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(target, 0o640)
    if os.getuid() == 0:
        os.chown(target, 10001, 10001)
        os.setgroups([])
        os.setgid(10001)
        os.setuid(10001)
    os.environ["DEER_FLOW_AUTH_DISABLED"] = "0"
    os.environ["DEER_FLOW_CONFIG_PATH"] = str(target)
    port = int(os.environ.get("PORT", "8001"))
    if not 1 <= port <= 65535:
        raise ValueError("Invalid PORT")
    os.execv(sys.executable, [sys.executable, "-m", "uvicorn", "app.gateway.app:app", "--host", "0.0.0.0", "--port", str(port), "--workers", "1", "--timeout-graceful-shutdown", "10"])


if __name__ == "__main__":
    main()
