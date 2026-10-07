import { access } from "node:fs/promises";
import path from "node:path";
import type {
  CreateInspectionProfileInput,
  CreateInspectionRuleInput,
  DeleteInspectionProfileInput,
  DeleteInspectionRuleInput,
  InspectionPromptProfile,
  InspectionPromptRule,
  ReorderInspectionRulesInput,
  ReviewRuleProfile,
  UpdateInspectionRuleInput,
} from "./contracts.js";
import { ReviewRulesStore, type ReviewRulesStoreConfig } from "./review-rules.js";

export interface InspectionRulesStoreConfig {
  rulesDir: string;
  profileConfigPath: string;
  maintainerRootDir?: string;
}

export interface InspectionRulesStorePort {
  list(maintainerId?: string): Promise<InspectionPromptProfile[]>;
  readForProject(projectPath: string, maintainerId?: string): Promise<InspectionPromptProfile>;
  createProfile(input: CreateInspectionProfileInput, maintainerId?: string): Promise<InspectionPromptProfile>;
  deleteProfile(input: DeleteInspectionProfileInput, maintainerId?: string): Promise<void>;
  createRule(input: CreateInspectionRuleInput, maintainerId?: string): Promise<InspectionPromptProfile>;
  updateRule(input: UpdateInspectionRuleInput, maintainerId?: string): Promise<InspectionPromptProfile>;
  deleteRule(input: DeleteInspectionRuleInput, maintainerId?: string): Promise<InspectionPromptProfile>;
  reorderRules(input: ReorderInspectionRulesInput, maintainerId?: string): Promise<InspectionPromptProfile>;
}

function asInspectionProfile(profile: ReviewRuleProfile): InspectionPromptProfile {
  return {
    name: profile.name,
    displayName: profile.displayName,
    isDefault: profile.isDefault,
    rules: profile.rules.map((rule): InspectionPromptRule => ({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      enabled: rule.enabled,
      order: rule.order,
      file: rule.file,
      sharedBy: rule.sharedBy,
      content: rule.content,
    })),
  };
}

function inspectionError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message.replaceAll("审查", "巡检"));
}

/**
 * Inspection owns this store and its configuration path. The Markdown profile
 * persistence mechanics are shared with Review, but no Review profile data is
 * read because this instance points at config/inspection-profiles.json and the
 * inspection-only rules directory.
 */
export class InspectionRulesStore implements InspectionRulesStorePort {
  private readonly markdownStore: ReviewRulesStore;
  private readonly maintainerRootDir: string;
  private readonly scopedStores = new Map<string, ReviewRulesStore>();
  private readonly scopedInitializations = new Map<string, Promise<void>>();

  constructor(config: InspectionRulesStoreConfig) {
    const rulesDir = config.rulesDir || path.join(process.cwd(), "config/skills/inspection");
    const profileConfigPath = config.profileConfigPath || path.join(process.cwd(), "config/inspection-profiles.json");
    this.markdownStore = new ReviewRulesStore({ rulesDir, profileConfigPath });
    this.maintainerRootDir = config.maintainerRootDir ?? path.join(path.dirname(profileConfigPath), "inspection-maintainers");
  }

  async list(maintainerId?: string): Promise<InspectionPromptProfile[]> {
    try {
      return (await (await this.storeFor(maintainerId)).list()).map(asInspectionProfile);
    } catch (error) {
      throw inspectionError(error);
    }
  }

  async readForProject(projectPath: string, maintainerId?: string): Promise<InspectionPromptProfile> {
    try {
      return asInspectionProfile(await (await this.storeFor(maintainerId)).readForProject(projectPath));
    } catch (error) {
      throw inspectionError(error);
    }
  }

  async createProfile(input: CreateInspectionProfileInput, maintainerId?: string): Promise<InspectionPromptProfile> {
    try {
      return asInspectionProfile(await (await this.storeFor(maintainerId)).createProfile(input));
    } catch (error) {
      throw inspectionError(error);
    }
  }

  async deleteProfile(input: DeleteInspectionProfileInput, maintainerId?: string): Promise<void> {
    try {
      await (await this.storeFor(maintainerId)).deleteProfile(input);
    } catch (error) {
      throw inspectionError(error);
    }
  }

  async createRule(input: CreateInspectionRuleInput, maintainerId?: string): Promise<InspectionPromptProfile> {
    try {
      return asInspectionProfile(await (await this.storeFor(maintainerId)).createRule(input));
    } catch (error) {
      throw inspectionError(error);
    }
  }

  async updateRule(input: UpdateInspectionRuleInput, maintainerId?: string): Promise<InspectionPromptProfile> {
    try {
      return asInspectionProfile(await (await this.storeFor(maintainerId)).updateRule(input));
    } catch (error) {
      throw inspectionError(error);
    }
  }

  async deleteRule(input: DeleteInspectionRuleInput, maintainerId?: string): Promise<InspectionPromptProfile> {
    try {
      return asInspectionProfile(await (await this.storeFor(maintainerId)).deleteRule(input));
    } catch (error) {
      throw inspectionError(error);
    }
  }

  async reorderRules(input: ReorderInspectionRulesInput, maintainerId?: string): Promise<InspectionPromptProfile> {
    try {
      return asInspectionProfile(await (await this.storeFor(maintainerId)).reorderRules(input));
    } catch (error) {
      throw inspectionError(error);
    }
  }

  private async storeFor(maintainerId?: string): Promise<ReviewRulesStore> {
    if (!maintainerId?.trim()) return this.markdownStore;
    const normalized = maintainerId.trim();
    const existing = this.scopedStores.get(normalized);
    if (existing) {
      const pending = this.scopedInitializations.get(normalized);
      if (pending) await pending;
      return existing;
    }
    const scopeDir = path.join(this.maintainerRootDir, Buffer.from(normalized, "utf8").toString("base64url"));
    const config: ReviewRulesStoreConfig = {
      rulesDir: path.join(scopeDir, "rules"),
      profileConfigPath: path.join(scopeDir, "profiles.json"),
    };
    const store = new ReviewRulesStore(config);
    this.scopedStores.set(normalized, store);
    const initialization = access(config.profileConfigPath).catch(() => this.markdownStore.cloneTo(config));
    this.scopedInitializations.set(normalized, initialization);
    try {
      await initialization;
    } finally {
      this.scopedInitializations.delete(normalized);
    }
    return store;
  }
}
