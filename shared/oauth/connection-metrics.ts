import type { ConnectionPhase, ProviderRevocationResult } from "./connection-types";
import type { OAuthProvider } from "./store";

export type ConnectionLifecycleMetric =
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
    };

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
