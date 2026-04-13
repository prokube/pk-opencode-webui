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
}): Promise<Session | null> {
  const created = await args.client.session.create({});
  if (!created.data) return null;
  try {
    await args.client.session.promptAsync({
      sessionID: created.data.id,
      parts: [{ type: "text", text: args.text }],
      agent: args.agent,
      model: args.model,
    });
  } catch (err) {
    await args.client.session.delete({ sessionID: created.data.id }).catch(() => undefined);
    throw err;
  }
  return created.data;
}
