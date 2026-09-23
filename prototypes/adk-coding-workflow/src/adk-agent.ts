import {
  BaseAgent,
  InMemoryRunner,
  createEvent,
  createEventActions,
  type Event,
  type InvocationContext,
} from "@google/adk"

import type { WorkflowRequest, WorkflowResult } from "./domain"
import type { CodingWorkflow } from "./workflow"

export class CodingWorkflowAgent extends BaseAgent {
  constructor(private readonly workflow: CodingWorkflow) {
    super({
      name: "CodingWorkflow",
      description: "Runs a deterministic issue-to-pull-request coding workflow.",
    })
  }

  protected async *runAsyncImpl(context: InvocationContext): AsyncGenerator<Event, void, void> {
    const request = context.session.state.workflowRequest as WorkflowRequest | undefined
    if (!request) throw new Error("workflowRequest is missing from ADK session state")
    const result = await this.workflow.run(request)
    yield createEvent({
      author: this.name,
      content: { role: "model", parts: [{ text: JSON.stringify(result, null, 2) }] },
      actions: createEventActions({ stateDelta: { workflowResult: result } }),
    })
  }

  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    throw new Error("Live execution is not supported by this prototype")
  }
}

export async function runWithAdk(workflow: CodingWorkflow, request: WorkflowRequest): Promise<WorkflowResult> {
  const runner = new InMemoryRunner({
    appName: "prokube_coding_workflow_prototype",
    agent: new CodingWorkflowAgent(workflow),
  })
  let result: WorkflowResult | undefined
  for await (const event of runner.runEphemeral({
    userId: "workflow-dispatcher",
    newMessage: { role: "user", parts: [{ text: `Run ${request.repository}#${request.issueNumber}` }] },
    stateDelta: { workflowRequest: request },
  })) {
    const value = event.actions.stateDelta.workflowResult
    if (value) result = value as WorkflowResult
  }
  if (!result) throw new Error("ADK workflow completed without a result")
  return result
}
