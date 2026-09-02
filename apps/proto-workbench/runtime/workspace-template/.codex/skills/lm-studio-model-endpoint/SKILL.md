---
name: lm-studio-model-endpoint
description: Use the project LM Studio provider for live model discovery, explicit loading, bounded chat, and ownership-safe unloading through the loopback API. Use for model configuration, connection verification, or local inference; never substitute a static model list or process health check for a real response.
---

# LM Studio Model Endpoint

Use `http://127.0.0.1:1234` as the single inference authority. Discover exact model keys from the live native catalogue, retain capabilities and loaded-instance state, and require an explicit load before generation.

For each request:

1. Reconcile the live catalogue immediately before acting.
2. Load the exact selected key through the native lifecycle route.
3. Generate through the OpenAI-compatible chat route with bounded input and output.
4. Read an optional token only from the documented environment variables; never persist or log it.
5. Unload only an instance created and tracked by this Workbench session.

A successful proof includes discovery, explicit load, a returned chat completion, and owned unload as separate observations. An externally loaded instance is observable but never owned.
