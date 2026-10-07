import { describe, expect, it } from "vitest";
import { detectAssistantIntent, planAssistantTask } from "../src/assistant-intent.js";

describe("assistant intent planning", () => {
  it("routes the supported workbench requests to focused task plans", () => {
    expect(detectAssistantIntent("帮我总结上周的工作任务")).toBe("weekly_work_summary");
    expect(detectAssistantIntent("统计 2026-08-01 到 2026-08-10 的提交记录")).toBe("gitlab_commit_activity");
    expect(detectAssistantIntent("列下我的待办 Jira")).toBe("jira_todos");
    expect(detectAssistantIntent("帮我新建一个 Jira 缺陷")).toBe("jira_issue_create");
    expect(detectAssistantIntent("怎么新建 Jira")).toBe("general");
    expect(detectAssistantIntent("查询 Jira 的 AIP-113931 详情")).toBe("jira_issue_search");
    expect(detectAssistantIntent("看看我创建的 GitLab MR")).toBe("gitlab_merge_requests");
    expect(detectAssistantIntent("帮我新建一个 GitLab MR")).toBe("gitlab_merge_request_create");
    expect(detectAssistantIntent("怎么新建 GitLab MR")).toBe("general");
    expect(detectAssistantIntent("查询 Review 任务状态")).toBe("review_status");
    expect(detectAssistantIntent("启动这个 Review")).toBe("review_action");
  });

  it("gives explicit Jira creation requests a write-capable, focused plan", () => {
    const plan = planAssistantTask([{ role: "user", content: "创建一个 Jira 问题" }]);

    expect(plan.intent).toBe("jira_issue_create");
    expect(plan.allowedToolNames).toEqual(["get_jira_create_options", "create_jira_issue"]);
    expect(plan.instructions.join("\n")).toContain("明确要求创建");
  });

  it("keeps a Jira creation flow available while the user supplies requested fields", () => {
    const plan = planAssistantTask([
      { role: "user", content: "帮我新建一个 Jira 问题" },
      { role: "assistant", content: "请补充标题、描述、模块和修复版本。" },
      { role: "user", content: "标题是登录超时，描述是复现登录超时，模块选前端，修复版本选 2026.08" },
    ]);

    expect(plan.intent).toBe("jira_issue_create");
    expect(plan.allowedToolNames).toEqual(["get_jira_create_options", "create_jira_issue"]);
  });

  it("keeps a GitLab MR creation flow available while the user supplies a member name", () => {
    const plan = planAssistantTask([
      { role: "user", content: "帮我新建一个 GitLab MR，项目 saas-frontend，源分支 feature/a，目标分支 dev" },
      { role: "assistant", content: "请补充 MR 标题和经办人。" },
      { role: "user", content: "标题是接入工作台，assign给yangting" },
    ]);

    expect(plan.intent).toBe("gitlab_merge_request_create");
    expect(plan.allowedToolNames).toEqual(["get_gitlab_current_user", "list_gitlab_contributed_projects", "get_gitlab_merge_request_create_options", "search_gitlab_project_members", "create_gitlab_merge_request"]);
  });

  it("uses the focused MR context when the user asks for an analysis", () => {
    const plan = planAssistantTask(
      [{ role: "user", content: "帮我看看这个 MR 有什么风险" }],
      { provider: "gitlab", resourceType: "merge_request", resourceId: "17", projectId: "7" },
    );

    expect(plan.intent).toBe("merge_request_analysis");
    expect(plan.allowedToolNames).toEqual(["get_gitlab_merge_request_details"]);
    expect(plan.includeReviewContext).toBe(false);
  });

  it("routes explicit GitLab MR operations to write-capable plans", () => {
    const focus = { provider: "gitlab" as const, resourceType: "merge_request" as const, resourceId: "26", projectId: "7" };
    expect(planAssistantTask([{ role: "user", content: "把这个 MR 的标题改成修复登录问题" }], focus)).toMatchObject({
      intent: "gitlab_merge_request_update",
      allowedToolNames: ["get_gitlab_merge_request_details", "get_gitlab_merge_request_create_options", "update_gitlab_merge_request"],
    });
    expect(planAssistantTask([{ role: "user", content: "合并这个 MR" }], focus).intent).toBe("gitlab_merge_request_merge");
    expect(planAssistantTask([{ role: "user", content: "在这个 MR 下评论：请补充测试" }], focus).intent).toBe("gitlab_note_create");
    expect(planAssistantTask([{ role: "user", content: "重试这个 Pipeline" }], focus).intent).toBe("gitlab_pipeline_action");
    expect(planAssistantTask([{ role: "user", content: "怎么合并这个 MR" }], focus).intent).toBe("general");
  });

  it("keeps unrelated questions out of workbench-specific formatting", () => {
    const plan = planAssistantTask([{ role: "user", content: "解释一下什么是幂等" }]);

    expect(plan.intent).toBe("general");
    expect(plan.includeReviewContext).toBe(false);
    expect(plan.allowedToolNames).toEqual([]);
  });
});
