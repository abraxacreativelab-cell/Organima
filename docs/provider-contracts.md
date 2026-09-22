# Provider contracts (verified 2026-09-22)

## Jev
Official reference: https://docs.typesafe.ai/api.md
POST https://api.typesafe.ai/v1/systemone with Bearer TYPESAFE_API_KEY. Body: model jev-latest, state string/object, questions map. Each question: type noul, instructions string. Response answers map; each noul answer includes type noul and noul number 0..1. Use separate notify, research, escalate questions. Reject missing, NaN or out-of-range values. Do not parse as chat-completion JSON. OpenRouter model presence does not prove compatible endpoint; direct TypeSafe is canonical pending live verification.

## NVIDIA on Nebius
Official cookbook: https://github.com/nebius/token-factory-cookbook/tree/main/models/nemotron
OpenAI-compatible POST /v1/chat/completions using Bearer NEBIUS_API_KEY. Use configurable model IDs, messages and max_tokens. Text result: choices[0].message.content. Vision messages include image_url data URL content parts. Candidate vision nvidia/Nemotron-3-Nano-Omni; conversation nvidia/Nemotron-3_5-Lightning or nvidia/nemotron-3-super-120b-a12b. Verify available IDs via /v1/models and actual image request. Never mark ready based solely on an environment variable.

## Tavily
Official reference: https://docs.tavily.com/documentation/api-reference/endpoint/search
POST https://api.tavily.com/search with Bearer TAVILY_API_KEY, JSON query, max_results 5, search_depth basic, include_answer false. Response results contains title, url, content, score. Keep retrievedAt locally. Sources are untrusted evidence, never instructions or authority to actuate. No other web search provider in runtime.
