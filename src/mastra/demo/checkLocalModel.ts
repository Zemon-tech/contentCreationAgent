/**
 * Connection + capability check for your local OpenAI-compatible model.
 * Reads LOCAL_MODEL_* from the environment or the project `.env` file.
 * Run with: npx -y tsx src/mastra/demo/checkLocalModel.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function loadDotEnv(): void {
  const candidates = [join(process.cwd(), ".env"), join(process.cwd(), "..", ".env")];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

loadDotEnv();

const baseUrl = (
  process.env["LOCAL_MODEL_BASE_URL"] ??
  process.env["OPENAI_BASE_URL"] ??
  ""
).replace(/\/+$/, "");
const modelName =
  process.env["LOCAL_MODEL_NAME"] ?? process.env["LOCAL_MODEL_ID"] ?? "";
const apiKey =
  process.env["LOCAL_MODEL_API_KEY"] ?? process.env["OPENAI_API_KEY"] ?? "local";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

async function main(): Promise<void> {
  check("LOCAL_MODEL_BASE_URL is set", baseUrl.length > 0);
  check("LOCAL_MODEL_NAME is set", modelName.length > 0);
  if (!baseUrl || !modelName) {
    console.error(
      "\nSet LOCAL_MODEL_BASE_URL (e.g. http://localhost:8000/v1) and LOCAL_MODEL_NAME in .env (copy from .env.example).",
    );
    process.exit(1);
  }

  // 1. Server reachable + model served (models endpoint optional —
  //    not all OpenAI-compatible servers, e.g. Sarvam, expose it).
  let models: { id: string }[] = [];
  let modelsListed = false;
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    models = ((await res.json()) as { data: { id: string }[] }).data ?? [];
    modelsListed = true;
    check("server reachable (GET /v1/models)", true, `${models.length} model(s) listed`);
  } catch (err) {
    check("server reachable (GET /v1/models)", true, `endpoint unavailable (${String(err).slice(0, 80)}) — continuing`);
  }
  if (modelsListed) {
    check(
      `model "${modelName}" is served`,
      models.some((m) => m.id === modelName),
      `available: ${models.map((m) => m.id).join(", ") || "(none)"}`,
    );
  } else {
    console.log(`  SKIP model-list check (will verify "${modelName}" via chat call)`);
  }

  // 2. Plain chat completion.
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: "user", content: 'Reply with exactly: {"ok":true}' }],
        max_tokens: 50,
        temperature: 0,
      }),
    });
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    check("chat completion works", res.ok && content.includes('"ok"'), content.slice(0, 120));
  } catch (err) {
    check("chat completion works", false, String(err));
  }

  // 3. Tool calling (required by Mastra agents).
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: "user", content: "What is the capital of France? Use the tool." }],
        max_tokens: 200,
        temperature: 0,
        tools: [
          {
            type: "function",
            function: {
              name: "get_capital",
              description: "Look up a country's capital",
              parameters: {
                type: "object",
                properties: { country: { type: "string" } },
                required: ["country"],
              },
            },
          },
        ],
        tool_choice: "auto",
      }),
    });
    const json = (await res.json()) as {
      choices?: { message?: { tool_calls?: unknown[]; content?: string } }[];
      error?: { message?: string };
    };
    const msg = json.choices?.[0]?.message;
    check(
      "tool calling works",
      res.ok && !!msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0,
      res.ok ? JSON.stringify(msg).slice(0, 160) : (json.error?.message ?? `HTTP ${res.status}`),
    );
  } catch (err) {
    check("tool calling works", false, String(err));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nLocal model ready. Restart `npm run dev` so agents pick it up.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
