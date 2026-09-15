{{/*
Everything that differs between the five workloads lives here, as data. The
workload template consumes this spec and knows nothing about any component.
*/}}

{{- define "mcp-gateway.componentNames" -}}
agentgateway: agentgateway
googleWorkspace: google-workspace
dbMcp: db-mcp
githubWrapper: github-wrapper
githubMcp: github-mcp
{{- end -}}

{{- define "mcp-gateway.enabledComponents" -}}
{{- $root := . -}}
{{- $names := include "mcp-gateway.componentNames" . | fromYaml -}}
{{- $keys := list -}}
{{- range $key := (keys $names | sortAlpha) -}}
{{- if (index $root.Values $key).enabled -}}
{{- $keys = append $keys $key -}}
{{- end -}}
{{- end -}}
{{- toYaml $keys -}}
{{- end -}}

{{- define "mcp-gateway.componentSpec" -}}
{{- $root := .root -}}
{{- $key := .key -}}
{{- $v := index $root.Values $key -}}
{{- $name := index (include "mcp-gateway.componentNames" $root | fromYaml) $key -}}
{{- $broker := $root.Values.googleWorkspace.authorizationBroker -}}
{{- $brokerOn := include "mcp-gateway.brokerEnabled" $root -}}
{{- $caOn := $root.Values.postgresql.caBundle.enabled -}}

{{- $args := list -}}
{{- $env := list -}}
{{- $envFrom := list -}}
{{- $mounts := list -}}
{{- $volumes := list -}}
{{- $podSecurityContext := deepCopy $v.podSecurityContext -}}
{{- $podAnnotations := deepCopy ($v.podAnnotations | default dict) -}}
{{- $usesPgCa := false -}}

{{- if eq $key "agentgateway" -}}
{{- $args = list "--file" "/etc/agentgateway/config.yaml" -}}
{{- $mounts = append $mounts (dict "name" "config" "mountPath" "/etc/agentgateway/config.yaml" "subPath" "config.yaml" "readOnly" true) -}}
{{- $volumes = append $volumes (dict "name" "config" "configMap" (dict "name" (include "mcp-gateway.componentName" (dict "root" $root "component" "agentgateway-config")))) -}}
{{- $_ := set $podAnnotations "checksum/config" (include (print $root.Template.BasePath "/agentgateway-config.yaml") $root | sha256sum) -}}
{{- $introspection := list -}}
{{- range $index, $issuer := $root.Values.hop1.issuers -}}
{{- with $issuer.introspection -}}
{{- $introspection = append $introspection (dict "secret" (dict "name" .credentialSecretKeyRef.name "optional" true "items" (list (dict "key" .credentialSecretKeyRef.key "path" (printf "issuer-%d" $index))))) -}}
{{- end -}}
{{- end -}}
{{- if $introspection -}}
{{- $mounts = append $mounts (dict "name" "hop1-introspection" "mountPath" "/var/run/secrets/mcp-gateway/introspection" "readOnly" true) -}}
{{- $volumes = append $volumes (dict "name" "hop1-introspection" "projected" (dict "defaultMode" 288 "sources" $introspection)) -}}
{{- end -}}
{{- end -}}

{{- if eq $key "githubMcp" -}}
{{- $args = list "http" "--port" (printf "%v" $v.port) "--base-path" "/mcp" "--scope-challenge" -}}
{{- end -}}

{{/* Components that authenticate callers carry HOP-1 trust and provider secrets. */}}
{{- $authenticating := has $key (list "googleWorkspace" "githubWrapper") -}}
{{- if $authenticating -}}
{{- $usesPgCa = $caOn -}}
{{- $profiles := include "mcp-gateway.hop1Profiles" (dict "root" $root "includeBroker" (eq $key "githubWrapper")) -}}
{{- if ne $profiles "[]" -}}
{{- $env = append $env (dict "name" "HOP1_ISSUERS_JSON" "value" $profiles) -}}
{{- end -}}
{{- range $index, $issuer := $root.Values.hop1.issuers -}}
{{- with $issuer.introspection -}}
{{- $env = append $env (dict "name" (printf "HOP1_INTROSPECTION_CREDENTIAL_%d" $index) "valueFrom" (dict "secretKeyRef" (dict "name" .credentialSecretKeyRef.name "key" .credentialSecretKeyRef.key))) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- if eq $key "googleWorkspace" -}}
{{- if $v.policy.enabled -}}
{{- $env = append $env (dict "name" "GOOGLE_WORKSPACE_POLICY_FILE" "value" ($v.policy.mountPath | toString)) -}}
{{- $mounts = append $mounts (dict "name" "policy" "mountPath" $v.policy.mountPath "subPath" "google-workspace-policy.yaml" "readOnly" true) -}}
{{- $volumes = append $volumes (dict "name" "policy" "configMap" (dict "name" (include "mcp-gateway.componentName" (dict "root" $root "component" "google-workspace-policy")))) -}}
{{- $_ := set $podAnnotations "checksum/config" (include (print $root.Template.BasePath "/google-workspace-policy.yaml") $root | sha256sum) -}}
{{- end -}}
{{- if $brokerOn -}}
{{- $env = concat $env (list
      (dict "name" "MCP_BROKER_ENABLED" "value" "true")
      (dict "name" "MCP_AUTHORIZATION_ISSUER" "value" (include "mcp-gateway.brokerIssuer" $root))
      (dict "name" "MCP_RESOURCE_URI" "value" (include "mcp-gateway.resourceUri" $root))
      (dict "name" "MCP_BROKER_GOOGLE_REDIRECT_URI" "value" (include "mcp-gateway.brokerCallbackUri" $root))
      (dict "name" "MCP_BROKER_SIGNING_JWKS_FILE" "value" "/var/run/secrets/mcp-gateway/broker/signing-jwks.json")
      (dict "name" "MCP_BROKER_ACTIVE_KID" "value" ($broker.activeSigningKid | toString))
      (dict "name" "MCP_BROKER_SCOPES" "value" (join " " $broker.scopes))
      (dict "name" "MCP_OAUTH_STATIC_CLIENTS_JSON" "value" (toJson $broker.staticClients))
      (dict "name" "MCP_DCR_ENABLED" "value" (printf "%v" $broker.dcr.enabled))
      (dict "name" "MCP_DCR_ALLOW_LOOPBACK_REDIRECTS" "value" (printf "%v" $broker.dcr.allowLoopbackRedirects))) -}}
{{- with $broker.dcr.trustedProxy.header -}}
{{- $env = append $env (dict "name" "MCP_DCR_TRUSTED_PROXY_HEADER" "value" (. | toString)) -}}
{{- end -}}
{{- with $broker.dcr.trustedProxy.addresses -}}
{{- $env = append $env (dict "name" "MCP_DCR_TRUSTED_PROXY_ADDRESSES" "value" (join "," .)) -}}
{{- end -}}
{{- range $field, $envName := (dict "clientTtlMs" "MCP_DCR_CLIENT_TTL_MS" "maxClients" "MCP_DCR_MAX_CLIENTS" "maxRateKeys" "MCP_DCR_MAX_RATE_KEYS" "rateLimit" "MCP_DCR_RATE_LIMIT" "rateWindowMs" "MCP_DCR_RATE_WINDOW_MS") -}}
{{- if gt (int (index $broker.dcr $field)) 0 -}}
{{- $env = append $env (dict "name" $envName "value" (printf "%v" (index $broker.dcr $field))) -}}
{{- end -}}
{{- end -}}
{{- $keyring := $broker.signingKeyring.secretKeyRef -}}
{{- $mounts = append $mounts (dict "name" "broker-signing-keyring" "mountPath" "/var/run/secrets/mcp-gateway/broker" "readOnly" true) -}}
{{- $volumes = append $volumes (dict "name" "broker-signing-keyring" "secret" (dict
      "secretName" (default $root.Values.secrets.name $keyring.name)
      "defaultMode" 288
      "items" (list (dict "key" $keyring.key "path" "signing-jwks.json")))) -}}
{{- if not (hasKey $podSecurityContext "fsGroup") -}}
{{- $_ := set $podSecurityContext "fsGroup" 10001 -}}
{{- $_ := set $podSecurityContext "fsGroupChangePolicy" "OnRootMismatch" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* The wrapper's upstream is a Service of this release, not a fixed name. */}}
{{- if and (eq $key "githubWrapper") $root.Values.githubMcp.enabled (not (hasKey ($v.env | default dict) "GITHUB_MCP_UPSTREAM_URL")) -}}
{{- $upstream := include "mcp-gateway.componentName" (dict "root" $root "component" "github-mcp") -}}
{{- $env = append $env (dict "name" "GITHUB_MCP_UPSTREAM_URL" "value" (printf "http://%s:%v/mcp" $upstream $root.Values.githubMcp.port)) -}}
{{- end -}}

{{- if $v.env -}}
{{- range $envName := (keys $v.env | sortAlpha) -}}
{{- $env = append $env (dict "name" $envName "value" (printf "%v" (index $v.env $envName))) -}}
{{- end -}}
{{- end -}}

{{- if $usesPgCa -}}
{{- $env = append $env (dict "name" "POSTGRES_CA_BUNDLE_PATH" "value" (include "mcp-gateway.postgresqlCaPath" $root)) -}}
{{- $mounts = append $mounts (dict "name" "postgresql-ca" "mountPath" $root.Values.postgresql.caBundle.mountPath "readOnly" true) -}}
{{- $volumes = append $volumes (include "mcp-gateway.postgresqlCaVolume" $root | fromYaml) -}}
{{- end -}}

{{- $secretName := include "mcp-gateway.secretName" (dict "root" $root "values" $v) -}}
{{- if and $secretName (hasKey $v "secretRef") -}}
{{- $envFrom = append $envFrom (dict "secretRef" (dict "name" $secretName)) -}}
{{- end -}}

{{- toYaml (dict
      "name" $name
      "args" $args
      "env" $env
      "envFrom" $envFrom
      "volumeMounts" $mounts
      "volumes" $volumes
      "podSecurityContext" $podSecurityContext
      "podAnnotations" $podAnnotations) -}}
{{- end -}}
