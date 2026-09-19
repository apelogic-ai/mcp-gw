import type {
  ConnectionPhase,
  LifecycleErrorCategory,
  ProviderRevocationResult,
} from "./connection-types";
import type { OAuthProvider } from "./store";

export type ConnectionLifecycleMetric = (
  | {
      name: "status_latency_ms";
      provider: OAuthProvider;
      value: number;
    }
  | {
      name: "connections_by_phase";
      provider: OAuthProvider;
      phase: ConnectionPhase;
      value: 1;
    }
  | {
      name: "renewal_outcome";
      provider: OAuthProvider;
      operation: "automatic" | "manual";
      outcome:
        | "refreshed"
        | "already_fresh"
        | "refresh_not_supported"
        | "reauthorization_required"
        | "failure";
      value: 1;
      category?: LifecycleErrorCategory;
      durationMs?: number;
    }
  | {
      name: "renewal_attempt";
      provider: OAuthProvider;
      operation: "automatic" | "manual";
      value: 1;
    }
  | {
      name: "tool_scope_denied";
      provider: OAuthProvider;
      operation: string;
      value: 1;
    }
  | {
      name: "policy_denied";
      provider: OAuthProvider;
      operation: string;
      ruleId?: string;
      value: 1;
    }
  | {
      name: "provider_auth_rejection";
      provider: OAuthProvider;
      value: 1;
    }
  | {
      name: "lifecycle_phase_transition";
      provider: OAuthProvider;
      from: ConnectionPhase;
      to: ConnectionPhase;
      category?: LifecycleErrorCategory;
      value: 1;
    }
  | {
      name: "renewal_lock_wait_ms";
      provider: OAuthProvider;
      operation: "automatic" | "manual";
      value: number;
    }
  | {
      name: "reauthorization_required_transition";
      provider: OAuthProvider;
      value: 1;
    }
  | {
      name: "disconnect_request";
      provider: OAuthProvider;
      value: 1;
    }
  | {
      name: "pending_provider_cleanup_age_ms";
      provider: OAuthProvider;
      value: number;
    }
  | {
      name: "provider_cleanup_retry_outcome";
      provider: OAuthProvider;
      outcome: ProviderRevocationResult | "processing_failure";
      value: 1;
    }
) & { diagnosticId?: string };

/**
 * Low-cardinality lifecycle instrumentation. Implementations must not add a
 * principal, credential, state, provider response, or arbitrary error label.
 */
export interface ConnectionLifecycleMetricSink {
  record(metric: ConnectionLifecycleMetric): void;
}

export class InMemoryConnectionLifecycleMetricSink implements ConnectionLifecycleMetricSink {
  readonly metrics: ConnectionLifecycleMetric[] = [];

  record(metric: ConnectionLifecycleMetric): void {
    this.metrics.push({ ...metric });
  }
}

/** Structured stdout events for collection by the deployment's existing log pipeline. */
export class JsonLineConnectionLifecycleMetricSink implements ConnectionLifecycleMetricSink {
  constructor(private readonly write: (line: string) => void = (line) => console.info(line)) {}

  record(metric: ConnectionLifecycleMetric): void {
    const event: Record<string, unknown> = {
      type: "mcp_gw_connection_diagnostic",
      name: metric.name,
      provider: metric.provider,
      value: metric.value,
    };
    if (metric.diagnosticId && /^[0-9a-f-]{36}$/i.test(metric.diagnosticId)) {
      event.diagnosticId = metric.diagnosticId;
    }
    switch (metric.name) {
      case "connections_by_phase":
        event.phase = metric.phase;
        break;
      case "renewal_attempt":
      case "renewal_lock_wait_ms":
        event.operation = metric.operation;
        break;
      case "renewal_outcome":
        event.operation = metric.operation;
        event.outcome = metric.outcome;
        if (metric.category) event.category = metric.category;
        if (metric.durationMs !== undefined) event.durationMs = metric.durationMs;
        break;
      case "tool_scope_denied":
      case "policy_denied":
        event.operation = boundedOperation(metric.operation);
        if (metric.name === "policy_denied" && metric.ruleId) {
          event.ruleId = boundedRuleId(metric.ruleId);
        }
        break;
      case "lifecycle_phase_transition":
        event.from = metric.from;
        event.to = metric.to;
        if (metric.category) event.category = metric.category;
        break;
      case "status_latency_ms":
      case "reauthorization_required_transition":
      case "disconnect_request":
      case "pending_provider_cleanup_age_ms":
      case "provider_cleanup_retry_outcome":
      case "provider_auth_rejection":
        if (metric.name === "provider_cleanup_retry_outcome") event.outcome = metric.outcome;
        break;
    }
    this.write(JSON.stringify(event));
  }
}

function boundedOperation(value: string): string {
  return /^[a-z][a-z0-9_]*(?:\.[+]?[a-z][a-z0-9_-]*){0,5}$/.test(value) && value.length <= 128
    ? value
    : "unclassified";
}

function boundedRuleId(value: string): string {
  return /^[a-z][a-z0-9_.-]{0,63}$/.test(value) ? value : "unclassified";
}
