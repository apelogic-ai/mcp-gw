import { readFileSync } from "node:fs";

import { JsonlAuditSink, type AuditSink } from "../../../shared/audit/audit";
import {
  CompositePolicy,
  createOpaPolicyFromUrl,
  createYamlPolicyFromString,
  type PolicyFetch,
  type ToolPolicy,
} from "../../../shared/policy/policy";

export interface WrapperPolicyConfig {
  opaUrl?: string;
  yamlFile?: string;
}

export interface CreateWrapperPolicyOptions {
  config?: WrapperPolicyConfig;
  knownOperations?: ReadonlySet<string>;
  fetch?: PolicyFetch;
}

export function createWrapperPolicy(options: CreateWrapperPolicyOptions): ToolPolicy | undefined {
  const policies: ToolPolicy[] = [];
  if (options.config?.yamlFile) {
    policies.push(
      createYamlPolicyFromString(
        readFileSync(options.config.yamlFile, "utf8"),
        options.knownOperations,
      ),
    );
  }
  if (options.config?.opaUrl) {
    policies.push(createOpaPolicyFromUrl(options.config.opaUrl, options.fetch));
  }
  if (policies.length === 0) return undefined;
  return policies.length === 1 ? policies[0] : new CompositePolicy(policies);
}

export function createWrapperAuditSink(jsonlPath: string | undefined): AuditSink | undefined {
  return jsonlPath ? new JsonlAuditSink(jsonlPath) : undefined;
}
