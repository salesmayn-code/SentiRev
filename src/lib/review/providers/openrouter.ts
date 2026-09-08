import { z } from "zod";

/**
 * OpenRouter is the only external AI boundary in the first version. Keep the
 * model allow-list deliberately singular so a provider or model cannot be
 * substituted silently through configuration.
 */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1" as const;
export const OPENROUTER_CHAT_COMPLETIONS_URL =
  `${OPENROUTER_BASE_URL}/chat/completions` as const;

export const PRIMARY_MODEL = "cohere/north-mini-code:free" as const;
export const PROVIDER_MODELS = [PRIMARY_MODEL] as const;
export type ProviderModelId = (typeof PROVIDER_MODELS)[number];

export const PRIMARY_REASONING_ENABLED = true as const;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;
export const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;

export type OpenRouterFailureCode =
  | "missing_key"
  | "invalid_model"
  | "timeout"
  | "cancelled"
  | "network_error"
  | "rate_limited"
  | "provider_error"
  | "response_too_large"
  | "invalid_response";

export class OpenRouterError extends Error {
  readonly code: OpenRouterFailureCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    code: OpenRouterFailureCode,
    retryable: boolean,
    status?: number,
  ) {
    super(safeFailureMessage(code));
    this.name = "OpenRouterError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export type OpenRouterMessage = {
  role: "system" | "user";
  content: string;
};

export type OpenRouterCall = {
  apiKey: string;
  model: ProviderModelId;
  messages: readonly OpenRouterMessage[];
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

export type OpenRouterTextResponse = {
  model: ProviderModelId;
  content: string;
  status: number;
};

const providerModelSchema = z.literal(PRIMARY_MODEL);

/** Local strict response schema for Cohere North Mini Code Free. The adapter
 * validates every field locally because provider output is untrusted. */
export const OPENROUTER_REVIEW_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          chunkId: { type: "string" },
          severity: { type: "string", enum: ["Critical", "High", "Medium", "Low"] },
          category: { type: "string" },
          summary: { type: "string" },
          cited_lines: {
            type: "array",
            items: { type: "integer", minimum: 1 },
            minItems: 1,
          },
          reasoning: { type: "string" },
          snippet: { type: "string" },
        },
        required: [
          "chunkId",
          "severity",
          "category",
          "summary",
          "cited_lines",
          "reasoning",
          "snippet",
        ],
      },
    },
  },
  required: ["findings"],
} as const;

function safeFailureMessage(code: OpenRouterFailureCode): string {
  switch (code) {
    case "missing_key":
      return "OpenRouter credentials are not configured";
    case "invalid_model":
      return "OpenRouter model is not approved";
    case "timeout":
      return "OpenRouter provider timed out";
    case "cancelled":
      return "OpenRouter provider request was cancelled";
    case "network_error":
      return "OpenRouter provider could not be reached";
    case "rate_limited":
      return "OpenRouter provider rate limited the request";
    case "provider_error":
      return "OpenRouter provider returned an error";
    case "response_too_large":
      return "OpenRouter provider response exceeded the size limit";
    case "invalid_response":
      return "OpenRouter provider returned invalid data";
  }
}

function isApprovedModel(value: string): value is ProviderModelId {
  return providerModelSchema.safeParse(value).success;
}

function assertCall(call: OpenRouterCall): void {
  if (typeof call.apiKey !== "string" || call.apiKey.trim().length === 0) {
    throw new OpenRouterError("missing_key", false);
  }
  if (!isApprovedModel(call.model)) {
    throw new OpenRouterError("invalid_model", false);
  }
  if (
    !Array.isArray(call.messages) ||
    call.messages.length === 0 ||
    call.messages.some(
      (message) =>
        (message.role !== "system" && message.role !== "user") ||
        typeof message.content !== "string" ||
        message.content.length === 0,
    )
  ) {
    throw new OpenRouterError("invalid_response", false);
  }
}

function requestBody(call: OpenRouterCall): string {
  return JSON.stringify({
    model: call.model,
    messages: call.messages,
    temperature: 0,
    reasoning: {
      enabled: PRIMARY_REASONING_ENABLED,
      exclude: true,
    },
  });
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const parsedLength = Number.parseInt(declaredLength, 10);
    if (Number.isSafeInteger(parsedLength) && parsedLength > maxBytes) {
      throw new OpenRouterError("response_too_large", false);
    }
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new OpenRouterError("response_too_large", false);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new OpenRouterError("response_too_large", false);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function responseContent(value: unknown): string {
  const envelopeSchema = z.object({
    choices: z
      .array(
        z.object({
          message: z.object({ content: z.unknown() }),
        }),
      )
      .min(1),
  });
  const envelope = envelopeSchema.safeParse(value);
  if (!envelope.success) {
    throw new OpenRouterError("invalid_response", false);
  }

  const content = envelope.data.choices[0]?.message.content;
  if (typeof content === "string" && content.trim().length > 0) {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "text" &&
          "text" in part &&
          typeof part.text === "string"
        ) {
          return part.text;
        }
        return "";
      })
      .join("");
    if (text.trim().length > 0) return text;
  }

  throw new OpenRouterError("invalid_response", false);
}

function timeoutFor(call: OpenRouterCall): number {
  const timeoutMs = call.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new OpenRouterError("timeout", false);
  }
  return Math.min(timeoutMs, DEFAULT_PROVIDER_TIMEOUT_MS);
}

export async function requestOpenRouter(
  call: OpenRouterCall,
): Promise<OpenRouterTextResponse> {
  assertCall(call);
  const timeoutMs = timeoutFor(call);
  const fetchImpl = call.fetchImpl ?? fetch;

  if (call.signal?.aborted) {
    throw new OpenRouterError("cancelled", false);
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = (): void => {
    controller.abort();
  };
  call.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchImpl(OPENROUTER_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${call.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "SentiRev/0.1",
        },
        body: requestBody(call),
        signal: controller.signal,
      });
    } catch {
      if (timedOut) throw new OpenRouterError("timeout", true);
      if (call.signal?.aborted) {
        throw new OpenRouterError("cancelled", false);
      }
      throw new OpenRouterError("network_error", true);
    }

    let body: string;
    try {
      body = await readBoundedResponse(response, MAX_PROVIDER_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof OpenRouterError) throw error;
      if (timedOut) throw new OpenRouterError("timeout", true);
      if (call.signal?.aborted) throw new OpenRouterError("cancelled", false);
      throw new OpenRouterError("network_error", true);
    }

    if (!response.ok) {
      if (response.status === 408 || response.status === 425 || response.status === 429) {
        throw new OpenRouterError(
          response.status === 429 ? "rate_limited" : "provider_error",
          response.status !== 429,
          response.status,
        );
      }
      if (response.status >= 500) {
        throw new OpenRouterError("provider_error", true, response.status);
      }
      throw new OpenRouterError("provider_error", false, response.status);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      throw new OpenRouterError("invalid_response", false, response.status);
    }

    return {
      model: call.model,
      content: responseContent(parsed),
      status: response.status,
    };
  } finally {
    clearTimeout(timeoutHandle);
    call.signal?.removeEventListener("abort", abortFromParent);
  }
}
