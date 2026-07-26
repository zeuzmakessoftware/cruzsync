/**
 * Gemma 4 on the Gemini API, using native function calling.
 *
 * Endpoint:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *
 * Model ids: Google serves `gemma-4-31b-it` and `gemma-4-26b-a4b-it` through the
 * Gemini API. Ids such as `gemma-4-12b-it` exist on Hugging Face but are NOT
 * available on this endpoint, so we validate the configured id and say so
 * clearly rather than failing with an opaque 404.
 *
 * Runs server-side only. The API key never reaches the browser.
 */
import { SUPPORTED_GOOGLE_GEMMA_MODELS } from "@/lib/config";
import {
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  toolJsonSchema,
  type ToolName,
} from "../tools/schemas";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/**
 * Gemini's function declarations accept a subset of JSON Schema. Strip the
 * keywords it rejects so a valid Zod schema does not produce a 400.
 */
function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema === null || typeof schema !== "object") return schema;

  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const DROP = new Set([
    "$schema",
    "additionalProperties",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "default",
    "const",
    "allOf",
    "oneOf",
    "not",
    "if",
    "then",
    "else",
    "patternProperties",
  ]);

  for (const [k, v] of Object.entries(src)) {
    if (DROP.has(k)) continue;
    // Nullable unions become the concrete type plus `nullable: true`.
    if (k === "anyOf" && Array.isArray(v)) {
      const variants = v as Record<string, unknown>[];
      const nonNull = variants.filter((x) => x.type !== "null");
      if (nonNull.length === 1) {
        Object.assign(
          out,
          toGeminiSchema(nonNull[0]) as Record<string, unknown>,
        );
        if (nonNull.length !== variants.length) out.nullable = true;
        continue;
      }
      // Genuine unions are not expressible; fall back to a permissive string.
      out.type = "string";
      continue;
    }
    out[k] = toGeminiSchema(v);
  }
  // Gemini requires an explicit type on object schemas.
  if (out.properties && !out.type) out.type = "object";
  return out;
}

export function buildFunctionDeclarations() {
  return TOOL_NAMES.map((name: ToolName) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    parameters: toGeminiSchema(toolJsonSchema(name)),
  }));
}

export class GemmaModelUnsupportedError extends Error {}

export interface GenerateArgs {
  apiKey: string;
  model: string;
  systemPrompt: string;
  contents: GeminiContent[];
  signal?: AbortSignal;
}

export interface GenerateResult {
  parts: GeminiPart[];
  finishReason: string | null;
}

export async function generateContent(
  args: GenerateArgs,
): Promise<GenerateResult> {
  if (!SUPPORTED_GOOGLE_GEMMA_MODELS.includes(args.model as never)) {
    throw new GemmaModelUnsupportedError(
      `GEMMA_MODEL="${args.model}" is not served by the Gemini API. Supported ids: ${SUPPORTED_GOOGLE_GEMMA_MODELS.join(
        ", ",
      )}.`,
    );
  }

  const body = {
    // Gemma models on the Gemini API do not accept a separate
    // systemInstruction field, so the system prompt is prepended as the first
    // user turn. This is why `contents` always begins with it.
    contents: args.contents,
    tools: [{ functionDeclarations: buildFunctionDeclarations() }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 1400 },
  };

  const res = await fetch(
    `${BASE}/${encodeURIComponent(args.model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": args.apiKey,
      },
      body: JSON.stringify(body),
      signal: args.signal ?? AbortSignal.timeout(45_000),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Gemini API returned HTTP ${res.status}: ${text.slice(0, 400)}`,
    );
  }

  const json = (await res.json()) as {
    candidates?: {
      content?: { parts?: GeminiPart[] };
      finishReason?: string;
    }[];
    promptFeedback?: { blockReason?: string };
  };

  if (json.promptFeedback?.blockReason) {
    throw new Error(
      `Request blocked by the provider: ${json.promptFeedback.blockReason}`,
    );
  }

  const candidate = json.candidates?.[0];
  return {
    parts: candidate?.content?.parts ?? [],
    finishReason: candidate?.finishReason ?? null,
  };
}
