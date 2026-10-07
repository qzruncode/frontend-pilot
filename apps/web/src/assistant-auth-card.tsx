import { ArrowRight, GitBranch, KeyRound } from "lucide-react";
import { Link } from "react-router-dom";
import type { AssistantAuthCard as AssistantAuthCardData } from "@contracts";

export function AssistantAuthCard({ card }: { card: AssistantAuthCardData }) {
  const Icon = card.provider === "gitlab" ? GitBranch : KeyRound;
  return (
    <section className="assistant-auth-card" aria-label={card.title}>
      <span className="assistant-auth-card-icon"><Icon aria-hidden="true" /></span>
      <div className="assistant-auth-card-copy">
        <strong>{card.title}</strong>
        <p>{card.description}</p>
      </div>
      <Link className="assistant-auth-card-action" to={card.actionPath}>
        {card.actionLabel}<ArrowRight aria-hidden="true" />
      </Link>
    </section>
  );
}
