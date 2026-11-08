"""Offline regression test run inside the image against its locked packages."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import unittest

from erp_chat_model import ERPChatOpenAI


class ModelEventLoopTests(unittest.TestCase):
    def test_independent_event_loops_release_regular_and_streaming_connections(self):
        requests = []
        release_cancelled_response = threading.Event()

        class Handler(BaseHTTPRequestHandler):
            # A persistent server connection reproduces the old cached-client
            # bug; HTTP/1.0 would silently close it and conceal the problem.
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(payload)
                if payload.get("stream"):
                    chunks = [
                        {"id": "offline", "object": "chat.completion.chunk", "created": 1, "model": "erp-default", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "offline ok"}, "finish_reason": None}]},
                        {"id": "offline", "object": "chat.completion.chunk", "created": 1, "model": "erp-default", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
                    ]
                    body = ("".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode()
                    content_type = "text/event-stream"
                else:
                    body = json.dumps({"id": "offline", "object": "chat.completion", "created": 1, "model": "erp-default", "choices": [{"index": 0, "message": {"role": "assistant", "content": "offline ok"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}}).encode()
                    content_type = "application/json"
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if payload["messages"][-1]["content"] == "cancel fixture":
                    first, remaining = body.split(b"\n\n", 1)
                    self.wfile.write(first + b"\n\n")
                    self.wfile.flush()
                    release_cancelled_response.wait(timeout=5)
                    try:
                        self.wfile.write(remaining)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        pass  # The regression intentionally cancels this stream.
                else:
                    self.wfile.write(body)
                    self.wfile.flush()

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        models = []

        async def exercise():
            model = ERPChatOpenAI(
                model="erp-default", api_key="offline-test-only",
                base_url=f"http://127.0.0.1:{server.server_port}/v1",
                timeout=5, max_retries=0,
            )
            models.append(model)
            self.assertEqual((await model.ainvoke("offline fixture")).content, "offline ok")
            # The private pool assertion is intentional: dependency versions
            # are locked, and absence of idle sockets is the regression.
            self.assertEqual(model.http_async_client._transport._pool.connections, [])
            chunks = [chunk async for chunk in model.astream("offline fixture")]
            self.assertEqual("".join(chunk.content for chunk in chunks), "offline ok")
            self.assertEqual(model.http_async_client._transport._pool.connections, [])
            self.assertFalse(model.http_async_client.follow_redirects)
            self.assertEqual(model.root_async_client.max_retries, 0)
            return model

        async def subagent():
            try:
                await exercise()
            finally:
                # The subagent's loop owns the client until this work finishes.
                await models[-1].root_async_client.close()

        async def cancel_stream(model):
            stream = model.astream("cancel fixture")
            try:
                self.assertEqual((await anext(stream)).content, "offline ok")
                pending = asyncio.create_task(anext(stream))
                await asyncio.sleep(0)  # Let it start waiting for the next chunk.
                pending.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await pending
            finally:
                await stream.aclose()
                release_cancelled_response.set()
            self.assertEqual(model.http_async_client._transport._pool.connections, [])

        try:
            # Keep the Gateway loop alive while a subagent's thread creates and
            # uses its own model, then create another model on the Gateway loop.
            with asyncio.Runner() as gateway_loop:
                try:
                    gateway_loop.run(exercise())
                    with ThreadPoolExecutor(max_workers=1) as executor:
                        executor.submit(lambda: asyncio.run(subagent())).result(timeout=15)
                    model = gateway_loop.run(exercise())
                    gateway_loop.run(cancel_stream(model))
                finally:
                    for model in models:
                        if not model.http_async_client.is_closed:
                            gateway_loop.run(model.root_async_client.close())
            self.assertEqual(len({id(model.http_async_client) for model in models}), 3)
            self.assertEqual(len(requests), 7)
            self.assertTrue(all(request["model"] == "erp-default" for request in requests))
        finally:
            release_cancelled_response.set()
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
