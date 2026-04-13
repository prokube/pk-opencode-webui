import type {
  OpencodeClient,
  Session,
  SessionPromptAsyncData,
} from "../sdk/client";

type ModelKey = NonNullable<NonNullable<SessionPromptAsyncData["body"]>["model"]>;

interface StartSessionCheck {
  loading: boolean;
  providerCount: number;
  model: ModelKey | null;
  connected: string[];
}

export function formatStartError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  if (!err || typeof err !== "object") return "Unknown error";

  const msg = (err as { message?: unknown }).message;
  if (typeof msg === "string" && msg.trim()) return msg;

  const nested = (err as { error?: unknown }).error;
  if (nested !== undefined) {
    const text = formatStartError(nested);
    if (text !== "Unknown error") return text;
  }

  const detail = (err as { detail?: unknown }).detail;
  if (typeof detail === "string" && detail.trim()) return detail;

  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}") return json;
  } catch {
    return "Unknown error";
  }

  return "Unknown error";
}

export function startSessionError(args: StartSessionCheck) {
  if (args.loading) return "Providers are still loading. Please try again in a moment.";
  if (args.providerCount === 0) return "No providers are available. Please add one in Settings.";
  if (!args.model) return "Please select a model before sending messages. Click the model button in the header.";
  if (!args.connected.includes(args.model.providerID)) {
    return `Provider "${args.model.providerID}" is not connected. Please configure it in Settings.`;
  }
  return null;
}

export async function createSessionWithPrompt(args: {
  client: OpencodeClient;
  text: string;
  agent: string;
  model: ModelKey;
}): Promise<Session> {
  const created = await args.client.session.create({});
  if (!created.data) {
    const text = formatStartError((created as { error?: unknown }).error);
    throw new Error(text === "Unknown error" ? "Failed to create session: no session data returned." : text);
  }
  try {
    const prompted = await args.client.session.promptAsync({
      sessionID: created.data.id,
      parts: [{ type: "text", text: args.text }],
      agent: args.agent,
      model: args.model,
    });
    if ("error" in prompted && prompted.error) {
      throw new Error(formatStartError(prompted.error));
    }
  } catch (err) {
    const cleaned = await args.client.session
      .delete({ sessionID: created.data.id })
      .catch((error) => ({ error }));
    if (cleaned && typeof cleaned === "object" && "error" in cleaned && cleaned.error) void cleaned.error;
    throw new Error(formatStartError(err), { cause: err });
  }
  return created.data;
}
