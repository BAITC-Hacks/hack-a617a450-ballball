import OpenAI from "openai";
import { AssistantError } from "./contracts.ts";
import type { ResponsesTransport } from "./contracts.ts";

if (typeof window !== "undefined") throw new Error("The assistant is server-only.");

export function createOpenAITransport(): { transport: ResponsesTransport; model: string } {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey?.trim() || !model?.trim()) throw new AssistantError("CONFIGURATION");
  const client = new OpenAI({
    apiKey, baseURL: "https://api.openai.com/v1", maxRetries: 0, timeout: 45_000,
    logLevel: "off", dangerouslyAllowBrowser: false,
  });
  return { model, transport: { async create(request) {
    try { return await client.responses.create(request); }
    catch { throw new AssistantError("OPENAI"); }
  } } };
}
