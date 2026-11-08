"""Keep the Gateway and subagent event loops on separate HTTP connections."""

from typing import Any

import httpx
from langchain_openai import ChatOpenAI


class ERPChatOpenAI(ChatOpenAI):
    """Avoid langchain-openai 1.2.1's process-wide cached async client.

    DeerFlow creates its subagents on a dedicated thread/event loop. Sharing
    the default client's connection pool with the Gateway causes cross-loop
    asyncio errors. Each model gets its own client, and completed responses
    leave no idle sockets waiting for garbage collection on a different loop.
    """

    def __init__(self, **kwargs: Any) -> None:
        kwargs["http_async_client"] = httpx.AsyncClient(
            timeout=kwargs.get("timeout", kwargs.get("request_timeout", 180)),
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=0),
            trust_env=False,
            follow_redirects=False,
        )
        super().__init__(**kwargs)
