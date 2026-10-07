import type { AppConfig } from "./config.js";
import type { ReviewProfile } from "./contracts.js";
import { ReviewRulesStore } from "./review-rules.js";

export async function loadReviewProfile(
  projectPath: string,
  { rulesDir, profileConfigPath }: Pick<AppConfig, "rulesDir" | "profileConfigPath">,
): Promise<ReviewProfile> {
  const profile = await new ReviewRulesStore({ rulesDir, profileConfigPath }).readForProject(projectPath);
  return {
    name: profile.name,
    displayName: profile.displayName,
    rules: profile.rules,
  };
}
