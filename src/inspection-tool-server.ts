import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  InspectionFindingReportInputSchema,
  type InspectionFindingReportInput,
  type InspectionFindingReportResult,
} from "./contracts.js";
import { safeErrorMessage } from "./errors.js";

export const INSPECTION_TOOL_SERVER_NAME = "inspection_workbench";
export const INSPECTION_REPORT_FINDING_TOOL_NAME = `mcp__${INSPECTION_TOOL_SERVER_NAME}__report_inspection_finding`;

export type InspectionFindingToolReporter = (
  finding: InspectionFindingReportInput,
) => Promise<InspectionFindingReportResult>;

function toolResult(result: InspectionFindingReportResult, isError = false) {
  const structuredContent: Record<string, unknown> = { ...result };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

export function createInspectionFindingToolServer(
  reporter: InspectionFindingToolReporter,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: INSPECTION_TOOL_SERVER_NAME,
    version: "1.0.0",
    alwaysLoad: true,
    instructions: "这是当前巡检任务的问题上报工具。问题由后端记录，模型不能直接操作数据库或 Jira。",
    tools: [
      tool(
        "report_inspection_finding",
        "在完成 Read、Grep 或 Glob 取证并确认一个具体问题后调用。每次只上报一个问题，不要批量上报，不要上报没有明确代码证据的猜测。",
        InspectionFindingReportInputSchema.shape,
        async (input) => {
          try {
            return toolResult(await reporter(input));
          } catch (error) {
            const result: InspectionFindingReportResult = {
              recorded: false,
              duplicate: false,
              findingId: "",
              message: safeErrorMessage(error, "问题未能记录，请继续完成当前规则检查。"),
            };
            return toolResult(result, true);
          }
        },
      ),
    ],
  });
}
