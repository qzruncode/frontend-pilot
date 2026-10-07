import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMissingFileError } from "./errors.js";

export const INSPECTION_OWNER_PROMPT_ID = "inspection-owner";
export const INSPECTION_JIRA_DESCRIPTION_PROMPT_ID = "inspection-jira-description";
export const INSPECTION_JIRA_FIELDS_PROMPT_ID = "inspection-jira-fields";
export const MERGE_REQUEST_DESCRIPTION_PROMPT_ID = "merge-request-description";

export const DEFAULT_INSPECTION_OWNER_PROMPT = `直接判断：每个巡检问题由谁负责修复？
负责人和代码作者在本流程中是同一个归属，不要拆成两套概念，也不要让用户从候选人中选择。
对每个问题主动查询并综合问题内容、相关代码、提交历史以及 GitLab/Jira/MR 上下文，返回真实可分派的 Jira username。不要只按最后一次 blame 或最后一个提交作者机械判断；跨文件问题要结合全部相关路径。
有足够依据时返回 resolved 和该账号；无法确认时返回 uncertain、assignee=null，并用一句话说明缺少什么。不要猜账号，不要创建、修改或分派 Jira。`;

export const DEFAULT_INSPECTION_JIRA_DESCRIPTION_PROMPT = `生成 Jira description，只输出正文，不输出 labels 或 duedate。

必须按以下顺序包含 3 个 Jira wiki 章节：
h2. 背景
说明已确认的业务场景、关联产品或用户故事，以及为什么需要处理；不要编造背景。

h2. 问题描述 / 目标
说明具体问题、影响或触发条件，以及本次要达成的目标；可补充已确认的代码位置、相关文件、建议方案和预期收益。

h2. 验收标准
列出可测试、可验证的完成条件，每条都使用 * [ ]。

规则：使用 Jira wiki 的 h2. 标题，不使用 Markdown ## 标题；加粗使用 Jira 的单星语法。只写已确认事实，不编造背景、影响、负责人或验证结果；不写 Out of Scope、不处理、不在本 MR 范围或范围外章节；不要写空泛、无法验证的验收条件。release label 和 duedate 是 Jira 字段，不要写进 description 正文。`;

export const DEFAULT_INSPECTION_JIRA_FIELDS_PROMPT = `只生成巡检 Jira 的 labels 和 dueDate；这两个值写入 Jira 字段，不要写进 description 正文，也不要输出其他字段。

规则：
- 普通新问题必须有一个 release-YYYYMMDD 标签，并将 dueDate 设为该标签对应的 YYYY-MM-DD。
- 未明确指定 release，或指定 release-auto 时，按创建日期计算下一个周四：周一至周四取本周四，周五至周日取下周四。
- 纯文档、配置或流程治理使用 release-TBD；交接、培训、规则制定等流程型问题使用 release-NA；预计跨越两个以上 release 使用 release-multi。这三类 dueDate 都留空。
- 已发布版本后的回归或 hotfix 使用 release-<已发版本>-回滚，并将 dueDate 设为明确的 hotfix 上线目标日；没有目标日时不要猜测。
- 不要猜测版本、日期或无依据的其他标签；标签去重，release 标签只保留一个。`;

export const DEFAULT_MERGE_REQUEST_DESCRIPTION_PROMPT = `生成 Merge Request 描述，只输出 Markdown 正文，不输出解释或代码围栏。

每个 MR 都必须关联 Jira：标题必须使用 <type>(<scope>): <一句话描述> (#JIRA-KEY)，描述的“关联”章节也必须写同一个 Jira key；没有 Jira key 时不要创建 MR。

描述必须按顺序包含以下四个章节：
## Background
写 Jira key 及 Jira、巡检、Lighthouse 报告或用户反馈等已知背景/链接。

## 改动
按“文件：改了什么”说明实际变更，不编造未发生的改动。

## 验证
使用 - [ ] 列出可执行或已执行的验证；只写事实，不虚构通过结果。适用时包含 lint、vitest、i18n:check 或浏览器 Lighthouse 复跑。

## 关联
写 - Jira: <JIRA-KEY>；有配套 MR 时再写 - 配套 MR: <!NNNN 关系说明>。

不要添加 Out of Scope、范围外或无法验证的空泛章节。`;

export interface InspectionPromptDefinition {
  id: string;
  name: string;
  description: string;
  fileName: string;
  defaultContent: string;
}

export interface InspectionPrompt {
  id: string;
  name: string;
  description: string;
  content: string;
}

export type InspectionPromptSummary = Omit<InspectionPrompt, "content">;

export const INSPECTION_PROMPT_DEFINITIONS: readonly InspectionPromptDefinition[] = [
  {
    id: INSPECTION_OWNER_PROMPT_ID,
    name: "巡检问题负责人",
    description: "由 AI 判断每个巡检问题对应的 Jira 负责人。",
    fileName: "inspection-owner.md",
    defaultContent: DEFAULT_INSPECTION_OWNER_PROMPT,
  },
  {
    id: INSPECTION_JIRA_DESCRIPTION_PROMPT_ID,
    name: "巡检 Jira 描述",
    description: "生成巡检问题的规范 Jira 描述正文。",
    fileName: "inspection-jira-description.md",
    defaultContent: DEFAULT_INSPECTION_JIRA_DESCRIPTION_PROMPT,
  },
  {
    id: INSPECTION_JIRA_FIELDS_PROMPT_ID,
    name: "巡检 Jira 字段",
    description: "生成巡检 Jira 的 release 标签和截止日期。",
    fileName: "inspection-jira-fields.md",
    defaultContent: DEFAULT_INSPECTION_JIRA_FIELDS_PROMPT,
  },
  {
    id: MERGE_REQUEST_DESCRIPTION_PROMPT_ID,
    name: "Merge Request 描述",
    description: "生成带 Jira 关联的规范 MR 描述正文。",
    fileName: "merge-request-description.md",
    defaultContent: DEFAULT_MERGE_REQUEST_DESCRIPTION_PROMPT,
  },
];

export interface InspectionPromptStoreConfig {
  promptDir: string;
  legacyOwnerPromptPath?: string;
  maintainerPromptDir?: string;
  definitions?: readonly InspectionPromptDefinition[];
}

export interface InspectionPromptStorePort {
  list(maintainerId?: string): Promise<InspectionPromptSummary[]>;
  read(id: string, maintainerId?: string): Promise<InspectionPrompt>;
  update(id: string, content: string, maintainerId?: string): Promise<InspectionPrompt>;
}

const MAX_PROMPT_BYTES = 100_000;

function normalizeContent(content: string): string {
  const normalized = content.trim();
  if (!normalized) throw new Error("提示词正文不能为空");
  if (Buffer.byteLength(normalized, "utf8") > MAX_PROMPT_BYTES) {
    throw new Error(`提示词正文不能超过 ${MAX_PROMPT_BYTES} 字节`);
  }
  return normalized;
}

function safePromptPath(promptDir: string, fileName: string): string {
  const root = path.resolve(promptDir);
  const resolved = path.resolve(root, fileName);
  const relative = path.relative(root, resolved);
  if (fileName.includes("\0") || !relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`提示词文件路径不安全：${fileName}`);
  }
  return resolved;
}

function maintainerPromptDir(rootDir: string, maintainerId: string): string {
  const normalized = maintainerId.trim();
  if (!normalized) throw new Error("维护人员身份不能为空");
  return path.join(path.resolve(rootDir), Buffer.from(normalized, "utf8").toString("base64url"));
}

function promptFrom(definition: InspectionPromptDefinition, content: string): InspectionPrompt {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    content: normalizeContent(content),
  };
}

export class InspectionPromptStore implements InspectionPromptStorePort {
  private readonly promptDir: string;
  private readonly legacyOwnerPromptPath: string | undefined;
  private readonly maintainerPromptDir: string;
  private readonly definitions: readonly InspectionPromptDefinition[];

  constructor(config: InspectionPromptStoreConfig) {
    this.promptDir = config.promptDir;
    this.legacyOwnerPromptPath = config.legacyOwnerPromptPath;
    this.maintainerPromptDir = config.maintainerPromptDir ?? path.join(config.promptDir, "maintainers");
    this.definitions = config.definitions ?? INSPECTION_PROMPT_DEFINITIONS;
  }

  async list(_maintainerId?: string): Promise<InspectionPromptSummary[]> {
    return this.definitions.map(({ id, name, description }) => ({ id, name, description }));
  }

  async read(id: string, maintainerId?: string): Promise<InspectionPrompt> {
    const definition = this.definition(id);
    return this.readDefinition(definition, maintainerId);
  }

  async update(id: string, content: string, maintainerId?: string): Promise<InspectionPrompt> {
    const definition = this.definition(id);
    const normalized = normalizeContent(content);
    const filePath = safePromptPath(maintainerId ? maintainerPromptDir(this.maintainerPromptDir, maintainerId) : this.promptDir, definition.fileName);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${normalized}\n`, "utf8");
    return promptFrom(definition, normalized);
  }

  private definition(id: string): InspectionPromptDefinition {
    const definition = this.definitions.find((item) => item.id === id);
    if (!definition) throw new Error(`提示词不存在：${id}`);
    return definition;
  }

  private async readDefinition(definition: InspectionPromptDefinition, maintainerId?: string): Promise<InspectionPrompt> {
    const filePaths = [
      ...(maintainerId ? [safePromptPath(maintainerPromptDir(this.maintainerPromptDir, maintainerId), definition.fileName)] : []),
      safePromptPath(this.promptDir, definition.fileName),
    ];
    if (definition.id === INSPECTION_OWNER_PROMPT_ID && this.legacyOwnerPromptPath) {
      filePaths.push(this.legacyOwnerPromptPath);
    }
    for (const filePath of filePaths) {
      try {
        return promptFrom(definition, await readFile(filePath, "utf8"));
      } catch (error) {
        if (isMissingFileError(error)) continue;
        throw error;
      }
    }
    return promptFrom(definition, definition.defaultContent);
  }
}
