import { useId, type ReactNode } from "react";
import { GitBranch, Ticket } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function IntegrationAccountCard({ service, description, status, tone = "neutral", children }: {
  service: "GitLab" | "Jira";
  description: string;
  status: string;
  tone?: "neutral" | "connected" | "unavailable";
  children: ReactNode;
}) {
  const titleId = useId();
  const Icon = service === "GitLab" ? GitBranch : Ticket;
  return <Card className="integration-account-card" role="region" aria-labelledby={titleId}>
    <CardHeader className="integration-account-heading">
      <span className={`integration-account-icon is-${service.toLowerCase()}`} aria-hidden="true"><Icon /></span>
      <div className="integration-account-title"><CardTitle id={titleId}>{service} 账号</CardTitle><p>{description}</p></div>
      <span className={`integration-account-status is-${tone}`}><i aria-hidden="true" />{status}</span>
    </CardHeader>
    <CardContent className="integration-account-content">{children}</CardContent>
  </Card>;
}
