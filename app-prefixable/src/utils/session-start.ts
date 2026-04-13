interface ModelKey {
  providerID: string;
  modelID: string;
}

interface StartSessionCheck {
  loading: boolean;
  providerCount: number;
  model: ModelKey | null;
  connected: string[];
}

interface PromptCreateClient {
  session: {
    create: (_args: object) => Promise<{ data?: { id: string } }>;
    promptAsync: (_args: {
      sessionID: string;
      parts: { type: "text"; text: string }[];
      agent: string;
      model: ModelKey;
    }) => Promise<unknown>;
  };
}

export function startSessionError(args: StartSessionCheck) {
  if (args.loading || args.providerCount === 0) return "Providers are still loading. Please try again in a moment.";
  if (!args.model) return "Please select a model before sending messages. Click the model button in the header.";
  if (!args.connected.includes(args.model.providerID)) {
    return `Provider "${args.model.providerID}" is not connected. Please configure it in Settings.`;
  }
  return null;
}

export async function createSessionWithPrompt(args: {
  client: PromptCreateClient;
  text: string;
  agent: string;
  model: ModelKey;
}) {
  const created = await args.client.session.create({});
  if (!created.data) return null;
  await args.client.session.promptAsync({
    sessionID: created.data.id,
    parts: [{ type: "text", text: args.text }],
    agent: args.agent,
    model: args.model,
  });
  return created.data;
}
