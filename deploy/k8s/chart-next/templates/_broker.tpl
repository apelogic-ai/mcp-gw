{{/*
Every public URL the deployment exposes is derived from routing.host plus two
paths. Origins therefore cannot disagree and are never cross-checked.
*/}}

{{- define "mcp-gateway.origin" -}}
{{- printf "https://%s" (required "routing.host is required" .Values.routing.host) -}}
{{- end -}}

{{- define "mcp-gateway.mcpPath" -}}
{{- .Values.routing.mcpPath | trimSuffix "/" | default "/" -}}
{{- end -}}

{{- define "mcp-gateway.oauthPath" -}}
{{- .Values.routing.oauthPath | trimSuffix "/" -}}
{{- end -}}

{{- define "mcp-gateway.resourceUri" -}}
{{- printf "%s%s" (include "mcp-gateway.origin" .) (include "mcp-gateway.mcpPath" .) -}}
{{- end -}}

{{- define "mcp-gateway.resourceMetadataPath" -}}
{{- $mcpPath := include "mcp-gateway.mcpPath" . -}}
{{- printf "/.well-known/oauth-protected-resource%s" (ternary "" $mcpPath (eq $mcpPath "/")) -}}
{{- end -}}

{{- define "mcp-gateway.brokerIssuer" -}}
{{- printf "%s%s" (include "mcp-gateway.origin" .) (include "mcp-gateway.oauthPath" .) -}}
{{- end -}}

{{- define "mcp-gateway.brokerCallbackUri" -}}
{{- printf "%s%s/google/broker/callback" (include "mcp-gateway.origin" .) (include "mcp-gateway.oauthPath" .) -}}
{{- end -}}

{{- define "mcp-gateway.brokerServiceName" -}}
{{- include "mcp-gateway.componentName" (dict "root" . "component" "authorization-broker") -}}
{{- end -}}

{{- define "mcp-gateway.brokerJwksPath" -}}
{{- printf "%s/.well-known/jwks.json" (include "mcp-gateway.oauthPath" .) -}}
{{- end -}}

{{- define "mcp-gateway.brokerInternalJwksUrl" -}}
{{- printf "http://%s:%v%s" (include "mcp-gateway.brokerServiceName" .) .Values.googleWorkspace.port (include "mcp-gateway.brokerJwksPath" .) -}}
{{- end -}}

{{/* Exact public paths the broker owns. */}}
{{- define "mcp-gateway.brokerRoutePaths" -}}
{{- $oauthPath := include "mcp-gateway.oauthPath" . -}}
{{- $paths := list
      (printf "/.well-known/oauth-authorization-server%s" $oauthPath)
      (printf "%s/authorize" $oauthPath)
      (printf "%s/token" $oauthPath)
      (printf "%s/.well-known/jwks.json" $oauthPath)
      (printf "%s/google/broker/callback" $oauthPath) -}}
{{- if .Values.googleWorkspace.authorizationBroker.dcr.enabled -}}
{{- $paths = append $paths (printf "%s/register" $oauthPath) -}}
{{- end -}}
{{- toYaml $paths -}}
{{- end -}}

{{- define "mcp-gateway.brokerEnabled" -}}
{{- if and .Values.googleWorkspace.enabled .Values.googleWorkspace.authorizationBroker.enabled -}}true{{- end -}}
{{- end -}}

{{/*
HOP-1 verification profiles. The broker profile is appended for consumers that
must trust broker-issued tokens; the broker itself verifies them natively.
*/}}
{{- define "mcp-gateway.hop1Profiles" -}}
{{- $root := .root -}}
{{- $profiles := list -}}
{{- range $index, $issuer := $root.Values.hop1.issuers -}}
{{- $profile := dict
      "name" $issuer.name
      "issuer" $issuer.issuer
      "jwksUrl" $issuer.jwksUrl
      "audiences" $issuer.audiences
      "allowedAlgorithms" $issuer.allowedAlgorithms
      "emailClaim" ($issuer.emailClaim | default "email")
      "subjectClaim" ($issuer.subjectClaim | default "sub") -}}
{{- with $issuer.introspection -}}
{{- $_ := set $profile "introspectionUrl" .url -}}
{{- $_ := set $profile "introspectionClientCredentialEnv" (printf "HOP1_INTROSPECTION_CREDENTIAL_%d" $index) -}}
{{- end -}}
{{- $profiles = append $profiles $profile -}}
{{- end -}}
{{- if and .includeBroker (include "mcp-gateway.brokerEnabled" $root) -}}
{{- $profiles = append $profiles (dict
      "name" "mcp-oauth-broker"
      "issuer" (include "mcp-gateway.brokerIssuer" $root)
      "jwksUrl" (include "mcp-gateway.brokerInternalJwksUrl" $root)
      "audiences" (list (include "mcp-gateway.resourceUri" $root))
      "allowedAlgorithms" (list "RS256")
      "emailClaim" "email"
      "subjectClaim" "sub") -}}
{{- end -}}
{{- toJson $profiles -}}
{{- end -}}

{{/*
The two invariants that cannot be derived. Accepting a Google ID token directly
at /mcp would bypass the broker entirely, so it stays a hard error.
*/}}
{{- define "mcp-gateway.assertBrokerTrust" -}}
{{- if include "mcp-gateway.brokerEnabled" . -}}
{{- range .Values.hop1.issuers -}}
{{- if eq (trimSuffix "/" .issuer) "https://accounts.google.com" -}}
{{- fail "hop1.issuers must not trust https://accounts.google.com directly while googleWorkspace.authorizationBroker is enabled: a Google ID token would be accepted at the MCP resource without passing through the broker" -}}
{{- end -}}
{{- if eq .name "mcp-oauth-broker" -}}
{{- fail "hop1 issuer name mcp-oauth-broker is reserved for the chart-generated broker profile" -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
