import type { CapturedUpstreamTool } from "./catalog-capture";
import type { GenericToolDecision } from "./descriptor";

export interface GenericCatalogDrift {
  withoutDecision: string[];
  missingUpstream: string[];
}

export function compareCatalogDecisions(
  decisions: GenericToolDecision[],
  upstreamTools: CapturedUpstreamTool[],
): GenericCatalogDrift {
  const upstreamNames = new Set(upstreamTools.map((tool) => tool.name));
  const decisionNames = new Set(decisions.map((decision) => decision.upstreamName));
  return {
    withoutDecision: [...upstreamNames].filter((name) => !decisionNames.has(name)).sort(),
    missingUpstream: [...decisionNames].filter((name) => !upstreamNames.has(name)).sort(),
  };
}
