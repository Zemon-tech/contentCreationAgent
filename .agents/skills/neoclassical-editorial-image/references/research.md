# Research Log (2026-09-22)

| Source | URL | Date | Finding → skill effect |
|---|---|---|---|
| Midjourney Docs — Prompt Basics | https://docs.midjourney.com/hc/en-us/articles/32023408776205-Prompt-Basics | 2026-09-22 | Short simple prompts best; subject/medium/environment/light/color/mood/composition; focus on wanted, use `--no` to exclude → midjourney strategy: concise seed + `--no` |
| Midjourney Docs — Parameter List | https://docs.midjourney.com/hc/en-us/articles/32859204029709-Parameter-List | 2026-09-22 | Params end-only: `--ar --chaos --no --sref --stylize --style raw --v --q --seed --weird --tile` → validated param set |
| Midjourney V8 prompting notes | https://gist.github.com/akshatmittal/662356590f6f5161b50b55252ee8425f | 2026-09-22 | 30–60 words, natural sentences, `--s 1000`+profile carries aesthetics → "concept first, constraints second, discovery third" |
| Every/Midjourney creative workflow (secondary reporting) | websearch 2026-09-22 | 2026-09-22 | Creative lead used MJ unpredictability + iterative remix to discover identity → Midjourney mode keeps discovery room, not one-shot spec |
| OpenAI Image prompting guide | https://developers.openai.com/api/docs/guides/image-prompting | 2026-09-22 | Scene/subject/details/constraints, labeled sections, reference roles, "change only X", exclusions, iterate one thing → openai strategy |
| OpenAI Cookbook gpt-image prompting | https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide.md | 2026-09-22 | gpt-image-2 world knowledge + production workflows, sizes `1024x1536`, quality/background params → generation_parameters mapping |
| BFL FLUX Prompting Guide | https://docs.bfl.ml/guides/prompting_summary | 2026-09-22 | Subject+Action+Style+Context, front-load, 10–30/30–80/80+ words, ≤512 tokens, natural language → flux strategy |
| BFL FLUX.2 guide | https://docs.bfl.ai/guides/prompting_guide_flux2 | 2026-09-22 | No negative prompts; HEX as `object is #HEX`; JSON prompts OK; prompt_upsampling → validator forbids flux negatives |
| BFL official skills repo | https://github.com/black-forest-labs/skills | 2026-09-22 | agentskills.io-compatible FLUX skills pattern → scaffold follows same skill layout |
| Google Imagen guide | https://ai.google.dev/gemini-api/docs/imagen | 2026-09-22 | Short→fast, long→detailed, iterative refine, `"quoted text"` + font hint; deprecated → migrate Nano Banana → google strategy |
| Google DeepMind Nano Banana prompt guide | https://deepmind.google/models/gemini-image/prompt-guide | 2026-09-22 | Subject/Composition/Action/Location/Style, detail-bit-by-bit, production aspect specs → google syntax |
| Google Gemini image best practices | https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/gemini-image-generation-best-practices | 2026-09-22 | Positive framing ("empty street" not "no cars"), camera terms, step-by-step for complex scenes → general/google wording rule |

Note: Every's exact internal prompts are proprietary; skill encodes publicly described
principles (old×new tension, knowledge-in-modern-context, tech-as-myth, saturated color,
surreal play, editorial storytelling) as visual properties, never claiming verbatim prompts.
