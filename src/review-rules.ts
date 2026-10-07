import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  CreateReviewProfileBodySchema,
  CreateReviewRuleBodySchema,
  DeleteReviewProfileBodySchema,
  DeleteReviewRuleBodySchema,
  ReorderReviewRulesBodySchema,
  UpdateReviewRuleBodySchema,
  type CreateReviewProfileInput,
  type CreateReviewRuleInput,
  type DeleteReviewProfileInput,
  type DeleteReviewRuleInput,
  type ReorderReviewRulesInput,
  type ReviewRuleProfile,
  type UpdateReviewRuleInput,
} from "./contracts.js";
import { isMissingFileError } from "./errors.js";

const StoredRuleSchema = z.object({
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(128),
  description: z.string().max(1_000).default(""),
  enabled: z.boolean().default(true),
  order: z.number().int().nonnegative().max(10_000).optional(),
  file: z.string().trim().min(1).max(256),
}).strict();

const ModernProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(128).optional(),
  rules: z.array(StoredRuleSchema).max(100).default([]),
}).strict();

const LegacyProfileSchema = z.object({
  auditFile: z.string().trim().min(1).max(256),
  rulesFile: z.string().trim().min(1).max(256).optional(),
  rulesEnabled: z.boolean().optional(),
}).strict();

const ProfileConfigSchema = z.record(
  z.string().trim().min(1).max(512),
  z.union([ModernProfileSchema, LegacyProfileSchema]),
).superRefine((profiles, context) => {
  if (Object.keys(profiles).length > 100) {
    context.addIssue({ code: "custom", message: "审查 profile 最多支持 100 个" });
  }
});

type RawStoredRule = z.infer<typeof StoredRuleSchema>;
type StoredRule = Omit<RawStoredRule, "order"> & { order: number };
type StoredProfile = { displayName: string; rules: StoredRule[] };
type StoredConfig = Record<string, StoredProfile>;

const MAX_PROFILE_CONFIG_BYTES = 100_000;
const MAX_RULE_FILE_BYTES = 480_000;
const RULE_READ_CONCURRENCY = 8;

export interface ReviewRulesStoreConfig {
  rulesDir: string;
  profileConfigPath: string;
}

export interface ReviewRulesStorePort {
  list(): Promise<ReviewRuleProfile[]>;
  readForProject(projectPath: string): Promise<ReviewRuleProfile>;
  createProfile(input: CreateReviewProfileInput): Promise<ReviewRuleProfile>;
  deleteProfile(input: DeleteReviewProfileInput): Promise<void>;
  createRule(input: CreateReviewRuleInput): Promise<ReviewRuleProfile>;
  updateRule(input: UpdateReviewRuleInput): Promise<ReviewRuleProfile>;
  deleteRule(input: DeleteReviewRuleInput): Promise<ReviewRuleProfile>;
  reorderRules(input: ReorderReviewRulesInput): Promise<ReviewRuleProfile>;
}

function ruleFilePath(rulesDir: string, fileName: string): string {
  const root = path.resolve(rulesDir);
  const segments = fileName.split(/[\\/]/);
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`审查规则文件路径不在 rulesDir 内：${fileName}`);
  }
  if (fileName.includes("\0") || path.isAbsolute(fileName) || segments.some((segment) => !segment)) {
    throw new Error(`审查规则文件路径不安全：${fileName}`);
  }
  const resolved = path.resolve(root, fileName);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`审查规则文件路径不在 rulesDir 内：${fileName}`);
  }
  return resolved;
}

async function readBoundedText(filePath: string, maxBytes: number, label: string): Promise<string> {
  const fileStats = await stat(filePath);
  if (fileStats.size > maxBytes) throw new Error(`${label} 超过 ${maxBytes} 字节限制`);
  const content = await readFile(filePath, "utf8");
  if (Buffer.byteLength(content, "utf8") > maxBytes) throw new Error(`${label} 超过 ${maxBytes} 字节限制`);
  return content;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  mapper: (item: T) => Promise<R>,
  concurrency = RULE_READ_CONCURRENCY,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  };
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function normalizeRules(rules: RawStoredRule[]): StoredRule[] {
  return rules
    .map((rule, index) => ({ rule, fallbackOrder: index, order: rule.order ?? index }))
    .sort((left, right) => left.order - right.order || left.fallbackOrder - right.fallbackOrder)
    .map(({ rule, order }, index) => ({ ...rule, order: index }));
}

function modernizeProfile(name: string, profile: z.infer<typeof ModernProfileSchema> | z.infer<typeof LegacyProfileSchema>): StoredProfile {
  if ("rules" in profile) {
    return {
      displayName: profile.displayName ?? (name === "default" ? "默认 profile" : name),
      rules: normalizeRules(profile.rules),
    };
  }
  return {
    displayName: name === "default" ? "默认 profile" : name,
    rules: normalizeRules([
      {
        id: "high-value",
        name: "高价值问题审查",
        description: "只报告有明确证据和实际影响的问题。",
        enabled: true,
        file: profile.auditFile,
      },
      ...(profile.rulesFile ? [{
        id: "project-governance",
        name: "项目规范规则",
        description: "检查项目约定、组件复用、表单和样式规则。",
        enabled: profile.rulesEnabled ?? false,
        file: profile.rulesFile,
      }] : []),
    ]),
  };
}

function normalizeConfig(value: z.infer<typeof ProfileConfigSchema>): StoredConfig {
  return Object.fromEntries(Object.entries(value).map(([name, profile]) => [name, modernizeProfile(name, profile)]));
}

function sharedFiles(config: StoredConfig): Map<string, string[]> {
  const files = new Map<string, string[]>();
  for (const [profileName, profile] of Object.entries(config)) {
    for (const rule of profile.rules) {
      files.set(rule.file, [...(files.get(rule.file) ?? []), profileName]);
    }
  }
  return files;
}

function parseStoreInput<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error(message);
  return parsed.data;
}

function createRuleId(name: string, rules: StoredProfile["rules"]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "rule";
  const existing = new Set(rules.map((rule) => rule.id));
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

async function removeIfUnreferenced(rulesDir: string, file: string, config: StoredConfig): Promise<void> {
  if (Object.values(config).some((profile) => profile.rules.some((rule) => rule.file === file))) return;
  try {
    await unlink(ruleFilePath(rulesDir, file));
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

export class ReviewRulesStore implements ReviewRulesStorePort {
  private readonly rulesDir: string;
  private readonly profileConfigPath: string;

  constructor(config: ReviewRulesStoreConfig) {
    this.rulesDir = config.rulesDir;
    this.profileConfigPath = config.profileConfigPath;
  }

  async cloneTo(config: ReviewRulesStoreConfig): Promise<void> {
    const sourceConfig = await this.readConfig();
    const target = new ReviewRulesStore(config);
    await mkdir(path.dirname(config.profileConfigPath), { recursive: true });
    await target.writeConfig(sourceConfig);
    const files = new Set(Object.values(sourceConfig).flatMap((profile) => profile.rules.map((rule) => rule.file)));
    await Promise.all([...files].map(async (file) => {
      const sourcePath = ruleFilePath(this.rulesDir, file);
      const targetPath = ruleFilePath(config.rulesDir, file);
      await mkdir(path.dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    }));
  }

  async list(): Promise<ReviewRuleProfile[]> {
    const config = await this.readConfig();
    const files = sharedFiles(config);
    return mapWithConcurrency(Object.keys(config), (name) => this.readProfile(name, config, files));
  }

  async readForProject(projectPath: string): Promise<ReviewRuleProfile> {
    const config = await this.readConfig();
    const name = config[projectPath] ? projectPath : "default";
    if (!config[name]) throw new Error(`没有为 ${projectPath} 配置审查 profile`);
    return this.readProfile(name, config, sharedFiles(config));
  }

  async createProfile(input: CreateReviewProfileInput): Promise<ReviewRuleProfile> {
    const parsed = parseStoreInput(CreateReviewProfileBodySchema, input, "审查 profile 内容格式不正确");
    const config = await this.readConfig();
    if (config[parsed.profile]) throw new Error(`审查 profile 已存在：${parsed.profile}`);
    config[parsed.profile] = { displayName: parsed.displayName ?? parsed.profile, rules: [] };
    await this.writeConfig(config);
    return this.readProfile(parsed.profile, config, sharedFiles(config));
  }

  async deleteProfile(input: DeleteReviewProfileInput): Promise<void> {
    const parsed = parseStoreInput(DeleteReviewProfileBodySchema, input, "审查 profile 内容格式不正确");
    if (parsed.profile === "default") throw new Error("默认 profile 不允许删除");
    const config = await this.readConfig();
    const profile = config[parsed.profile];
    if (!profile) throw new Error(`审查 profile 不存在：${parsed.profile}`);
    delete config[parsed.profile];
    await this.writeConfig(config);
    for (const rule of profile.rules) await removeIfUnreferenced(this.rulesDir, rule.file, config);
  }

  async createRule(input: CreateReviewRuleInput): Promise<ReviewRuleProfile> {
    const parsed = parseStoreInput(CreateReviewRuleBodySchema, input, "审查规则内容格式不正确");
    const config = await this.readConfig();
    const profile = config[parsed.profile];
    if (!profile) throw new Error(`审查 profile 不存在：${parsed.profile}`);
    const id = createRuleId(parsed.name, profile.rules);
    const file = `custom/${id}-${randomUUID().slice(0, 8)}.md`;
    const filePath = ruleFilePath(this.rulesDir, file);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, parsed.content, "utf8");
    profile.rules.push({ id, name: parsed.name, description: parsed.description, enabled: parsed.enabled, order: profile.rules.length, file });
    try {
      await this.writeConfig(config);
    } catch (error) {
      await removeIfUnreferenced(this.rulesDir, file, config);
      throw error;
    }
    return this.readProfile(parsed.profile, config, sharedFiles(config));
  }

  async updateRule(input: UpdateReviewRuleInput): Promise<ReviewRuleProfile> {
    const parsed = parseStoreInput(UpdateReviewRuleBodySchema, input, "审查规则内容格式不正确");
    const config = await this.readConfig();
    const profile = config[parsed.profile];
    if (!profile) throw new Error(`审查 profile 不存在：${parsed.profile}`);
    const rule = profile.rules.find((item) => item.id === parsed.ruleId);
    if (!rule) throw new Error(`审查规则不存在：${parsed.ruleId}`);
    await writeFile(ruleFilePath(this.rulesDir, rule.file), parsed.content, "utf8");
    rule.name = parsed.name;
    rule.description = parsed.description;
    rule.enabled = parsed.enabled;
    await this.writeConfig(config);
    return this.readProfile(parsed.profile, config, sharedFiles(config));
  }

  async deleteRule(input: DeleteReviewRuleInput): Promise<ReviewRuleProfile> {
    const parsed = parseStoreInput(DeleteReviewRuleBodySchema, input, "审查规则内容格式不正确");
    const config = await this.readConfig();
    const profile = config[parsed.profile];
    if (!profile) throw new Error(`审查 profile 不存在：${parsed.profile}`);
    const index = profile.rules.findIndex((item) => item.id === parsed.ruleId);
    if (index < 0) throw new Error(`审查规则不存在：${parsed.ruleId}`);
    const [removed] = profile.rules.splice(index, 1);
    profile.rules = normalizeRules(profile.rules);
    await this.writeConfig(config);
    await removeIfUnreferenced(this.rulesDir, removed.file, config);
    return this.readProfile(parsed.profile, config, sharedFiles(config));
  }

  async reorderRules(input: ReorderReviewRulesInput): Promise<ReviewRuleProfile> {
    const parsed = parseStoreInput(ReorderReviewRulesBodySchema, input, "审查规则顺序格式不正确");
    const config = await this.readConfig();
    const profile = config[parsed.profile];
    if (!profile) throw new Error(`审查 profile 不存在：${parsed.profile}`);

    const requestedIds = new Set(parsed.ruleIds);
    if (
      requestedIds.size !== profile.rules.length
      || profile.rules.some((rule) => !requestedIds.has(rule.id))
    ) {
      throw new Error("规则顺序必须包含该 profile 下的全部规则，且不能包含未知规则");
    }

    const rulesById = new Map(profile.rules.map((rule) => [rule.id, rule]));
    profile.rules = parsed.ruleIds.map((ruleId, order) => {
      const rule = rulesById.get(ruleId);
      if (!rule) throw new Error(`审查规则不存在：${ruleId}`);
      return { ...rule, order };
    });
    await this.writeConfig(config);
    return this.readProfile(parsed.profile, config, sharedFiles(config));
  }

  private async readConfig(): Promise<StoredConfig> {
    const content = await readBoundedText(this.profileConfigPath, MAX_PROFILE_CONFIG_BYTES, "审查 profile 配置");
    let value: unknown;
    try {
      value = JSON.parse(content) as unknown;
    } catch (error) {
      throw new Error(`审查 profile 配置无法解析：${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = ProfileConfigSchema.safeParse(value);
    if (!parsed.success) {
      const limitIssue = parsed.error.issues.find((issue) => issue.message.includes("最多支持"));
      throw new Error(limitIssue ? `审查 profile 配置${limitIssue.message}` : "审查 profile 配置格式不正确");
    }
    return normalizeConfig(parsed.data);
  }

  private async writeConfig(config: StoredConfig): Promise<void> {
    const content = `${JSON.stringify(config, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_PROFILE_CONFIG_BYTES) {
      throw new Error(`审查 profile 配置超过 ${MAX_PROFILE_CONFIG_BYTES} 字节限制`);
    }
    await writeFile(this.profileConfigPath, content, "utf8");
  }

  private async readProfile(name: string, config: StoredConfig, files: Map<string, string[]>): Promise<ReviewRuleProfile> {
    const profile = config[name];
    if (!profile) throw new Error(`审查 profile 不存在：${name}`);
    const rules = await mapWithConcurrency(profile.rules, async (rule) => ({
      ...rule,
      order: rule.order,
      sharedBy: files.get(rule.file) ?? [name],
      content: await readBoundedText(ruleFilePath(this.rulesDir, rule.file), MAX_RULE_FILE_BYTES, `审查规则 ${rule.name}`),
    }));
    return {
      name,
      displayName: profile.displayName ?? name,
      isDefault: name === "default",
      rules,
    };
  }
}
