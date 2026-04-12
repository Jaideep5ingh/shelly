import { mastra } from "./index.js";
import { workflowOutputSchema } from "./tools/digestTools.js";

interface Args {
  date?: string;
  dryRun?: boolean;
  mode?: "agent" | "workflow";
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "--date" && argv[i + 1]) {
      args.date = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (token === "--mode" && argv[i + 1]) {
      const mode = argv[i + 1];
      if (mode === "agent" || mode === "workflow") {
        args.mode = mode;
      }
      i += 1;
    }
  }
  return args;
}

function formatResult(result: { status: "sent" | "dry-run"; target: string; totalItems: number; dateLabel: string }): void {
  const { status, target, totalItems, dateLabel } = result;
  if (status === "dry-run") {
    process.stdout.write(`Mastra digest dry run complete for ${dateLabel}. Items: ${totalItems}. File: ${target}\n`);
    return;
  }

  process.stdout.write(`Mastra digest sent for ${dateLabel}. Items: ${totalItems}. Recipient: ${target}\n`);
}

function extractResultFromAgentOutput(output: {
  object?: unknown;
  text?: string;
  toolResults?: unknown;
}): { status: "sent" | "dry-run"; target: string; totalItems: number; dateLabel: string } {
  const fromObject = workflowOutputSchema.safeParse(output.object);
  if (fromObject.success) {
    return fromObject.data;
  }

  const toolResults = Array.isArray(output.toolResults) ? output.toolResults : [];
  for (let i = toolResults.length - 1; i >= 0; i -= 1) {
    const item = toolResults[i] as {
      payload?: { result?: unknown; toolName?: string };
    };
    const fromTool = workflowOutputSchema.safeParse(item.payload?.result);
    if (fromTool.success) {
      return fromTool.data;
    }

    if (item.payload?.toolName === "deliverDigestTool") {
      break;
    }
  }

  if (output.text) {
    try {
      const parsedText = JSON.parse(output.text);
      const fromText = workflowOutputSchema.safeParse(parsedText);
      if (fromText.success) {
        return fromText.data;
      }
    } catch {
      // Ignore non-JSON text output and continue to throw a clear error below.
    }
  }

  throw new Error("Agent did not return a valid digest result.");
}

async function runViaWorkflow(args: Args): Promise<void> {
  const workflow = mastra.getWorkflow("digestWorkflow");

  const run = await workflow.createRun();
  const result = await run.start({
    inputData: {
      date: args.date,
      dryRun: args.dryRun
    }
  });

  if (result.status !== "success") {
    throw new Error(`Workflow failed with status: ${result.status}`);
  }

  formatResult(result.result);
}

function buildAgentPrompt(args: Args): string {
  const dateLine = args.date ? `Date: ${args.date}` : "Date: use default timezone date";
  const dryRunLine = `Dry run: ${args.dryRun === true ? "true" : "false"}`;

  return [
    "Run the daily digest pipeline end-to-end using tools.",
    dateLine,
    dryRunLine,
    "Required order: resolve input -> fetch messages -> summarize messages -> build digest -> deliver digest.",
    "Return only final outcome fields in structured output."
  ].join("\n");
}

async function runViaAgent(args: Args): Promise<void> {
  const agent = mastra.getAgent("digestCoordinatorAgent");
  const output = await agent.generate(buildAgentPrompt(args), {
    structuredOutput: {
      schema: workflowOutputSchema
    }
  });

  const result = extractResultFromAgentOutput(output);
  formatResult(result);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode ?? "agent";

  if (mode === "workflow") {
    await runViaWorkflow(args);
    return;
  }

  try {
    await runViaAgent(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Agent mode failed (${message}). Falling back to workflow mode.\n`);
    await runViaWorkflow(args);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
