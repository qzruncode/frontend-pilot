import { describe, expect, it } from "vitest";
import { buildInspectionJiraSummary, shortenInspectionFindingTitle } from "../src/inspection-title.js";

describe("inspection finding titles", () => {
  it("moves code locations and follow-up evidence out of the title", () => {
    const issue = "getGatewayUrl (src/utils/getGatewayUrl.ts:7) 用 window.location.origin 硬拼 /gateway/isgw/ 前缀，忽略了 getGatewayPrefix() (src/utils/getGatewayPrefix.ts) 中的 base path；而 useExperienceChat.ts:86 仍使用旧逻辑";

    expect(shortenInspectionFindingTitle(issue, "src/utils/getGatewayUrl.ts", 7)).toBe("getGatewayUrl 用 window.location.origin 硬拼 /gateway/isgw/ 前缀，忽略了 getGatewayPrefix() 中的 base path");
    expect(buildInspectionJiraSummary("medium", issue, "src/utils/getGatewayUrl.ts", 7)).toBe("[巡检][medium] getGatewayUrl 用 window.location.origin 硬拼 /gateway/isgw/ 前缀，忽略了 getGatewayPrefix() 中的 base path");
  });

  it("keeps a short complete issue and clips only genuinely long text", () => {
    expect(shortenInspectionFindingTitle("文件当前 818 行，超过 600 行上限", "src/components/Form.tsx", null)).toBe("文件当前 818 行，超过 600 行上限");
    expect(shortenInspectionFindingTitle("a".repeat(200))).toHaveLength(96);
  });
});
