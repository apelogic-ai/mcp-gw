import { redactValue } from "../audit/audit";

export type PolicyActionClass = "read" | "write" | "destructive";

export interface ToolPolicyInput {
  principal: string;
  tool: string;
  service: string;
  actionClass: PolicyActionClass;
  scopes: string[];
  args: Record<string, unknown>;
}

export type PolicyDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "approval_required"; reason: string };

export interface ToolPolicy {
  decide(input: ToolPolicyInput): Promise<PolicyDecision>;
}

export class AllowAllPolicy implements ToolPolicy {
  decide(input: ToolPolicyInput): Promise<PolicyDecision> {
    void input;
    return Promise.resolve({ kind: "allow" });
  }
}

export interface OpaPolicyRequest {
  input: ToolPolicyInput;
}

export interface OpaPolicyResponse {
  result?: {
    allow?: boolean;
    approval_required?: boolean;
    reason?: string;
  };
}

export type OpaPolicyEvaluator = (request: OpaPolicyRequest) => Promise<OpaPolicyResponse>;
export type PolicyFetch = (url: string, init?: RequestInit) => Promise<Response>;

export class OpaPolicyAdapter implements ToolPolicy {
  constructor(private readonly evaluate: OpaPolicyEvaluator) {}

  async decide(input: ToolPolicyInput): Promise<PolicyDecision> {
    const response = await this.evaluate({
      input: {
        ...input,
        args: redactValue(input.args) as Record<string, unknown>,
      },
    });
    const result = response.result;

    if (result?.allow) {
      return { kind: "allow" };
    }

    const reason = result?.reason ?? "policy denied";
    if (result?.approval_required) {
      return { kind: "approval_required", reason };
    }

    return { kind: "deny", reason };
  }
}

export function createOpaPolicyFromUrl(url: string, fetchImpl: PolicyFetch = fetch): ToolPolicy {
  return new OpaPolicyAdapter(async (request) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      return {
        result: {
          allow: false,
          reason: `OPA policy request failed: ${String(response.status)}`,
        },
      };
    }

    return (await response.json()) as OpaPolicyResponse;
  });
}
