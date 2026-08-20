{{- define "mcp-gateway.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "mcp-gateway.hop1IssuersJson" -}}
{{- $profiles := list -}}
{{- range $index, $issuer := . -}}
{{- $profile := dict "name" $issuer.name "issuer" $issuer.issuer "jwksUrl" $issuer.jwksUrl "audiences" $issuer.audiences "allowedAlgorithms" $issuer.allowedAlgorithms "emailClaim" ($issuer.emailClaim | default "email") "subjectClaim" ($issuer.subjectClaim | default "sub") -}}
{{- with $issuer.introspection -}}
{{- $_ := set $profile "introspectionUrl" .url -}}
{{- $_ := set $profile "introspectionClientCredentialEnv" (printf "HOP1_INTROSPECTION_CREDENTIAL_%d" $index) -}}
{{- end -}}
{{- $profiles = append $profiles $profile -}}
{{- end -}}
{{- toJson $profiles -}}
{{- end -}}

{{- define "mcp-gateway.fullname" -}}
{{- .Release.Name -}}
{{- end -}}

{{- define "mcp-gateway.labels" -}}
app.kubernetes.io/name: {{ include "mcp-gateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "mcp-gateway.selectorLabels" -}}
app.kubernetes.io/name: {{ include "mcp-gateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "mcp-gateway.serviceAccountName" -}}
{{- $root := .root -}}
{{- $component := .component -}}
{{- $values := .values -}}
{{- if $values.serviceAccount.name -}}
{{- $values.serviceAccount.name -}}
{{- else -}}
{{- printf "%s-%s" (include "mcp-gateway.fullname" $root) $component -}}
{{- end -}}
{{- end -}}

{{/* Fail unless a loopback HTTP redirect is in the exact form accepted by URL(). */}}
{{- define "mcp-gateway.assertCanonicalLoopbackHttpUrl" -}}
{{- $name := .name -}}
{{- $value := .value -}}
{{- $url := urlParse $value -}}
{{- $authority := $url.host -}}
{{- $port := trimPrefix ":" (regexFind ":[0-9]+$" $authority) -}}
{{- $unsafePath := regexMatch "(?i)http://[^/?#]+(?:/[^?#]*)?(?:/(?:[.]{1,2}|%2e(?:%2e)?)(?:/|$)|%2f|%5c|//)" $value -}}
{{- $unsafeRawCharacters := regexMatch "[^\\x21-\\x7e]|[\\x22\\x3c\\x3e\\x5c\\x5e\\x60\\x7b\\x7d]" $value -}}
{{- if or (ne $url.scheme "http") (not $url.host) $url.userinfo $url.fragment (ne $authority (lower $authority)) (not $url.path) $unsafePath $unsafeRawCharacters (eq $port "80") (and $port (or (gt (len $port) 5) (gt (int $port) 65535) (and (gt (len $port) 1) (hasPrefix "0" $port)))) -}}
{{- fail (printf "%s must be an exact canonical loopback HTTP URL" $name) -}}
{{- end -}}
{{- end -}}

{{- define "mcp-gateway.serviceAccount" -}}
{{- $root := .root -}}
{{- $component := .component -}}
{{- $values := .values -}}
{{- if $values.serviceAccount.create }}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ include "mcp-gateway.serviceAccountName" (dict "root" $root "component" $component "values" $values) }}
  labels:
    {{- include "mcp-gateway.labels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ $component }}
  {{- with $values.serviceAccount.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
---
{{- end }}
{{- end -}}

{{- define "mcp-gateway.image" -}}
{{- $image := .image -}}
{{- if kindIs "string" $image -}}
{{- $image -}}
{{- else if $image.digest -}}
{{- printf "%s@%s" (required "image.repository is required when a component is enabled" $image.repository) $image.digest -}}
{{- else -}}
{{- printf "%s:%s" (required "image.repository is required when a component is enabled" $image.repository) ($image.tag | default .root.Chart.AppVersion) -}}
{{- end -}}
{{- end -}}

{{- define "mcp-gateway.podScheduling" -}}
{{- with .nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .topologySpreadConstraints }}
topologySpreadConstraints:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{- define "mcp-gateway.probes" -}}
{{- if .probes.liveness.enabled }}
livenessProbe:
  {{- omit .probes.liveness "enabled" | toYaml | nindent 2 }}
{{- end }}
{{- if .probes.readiness.enabled }}
readinessProbe:
  {{- omit .probes.readiness "enabled" | toYaml | nindent 2 }}
{{- end }}
{{- end -}}

{{- define "mcp-gateway.postgresqlCaBundlePath" -}}
{{- printf "%s/ca.crt" (trimSuffix "/" .Values.postgresql.caBundle.mountPath) -}}
{{- end -}}

{{- define "mcp-gateway.postgresqlCaEnv" -}}
{{- if .Values.postgresql.caBundle.enabled }}
- name: POSTGRES_CA_BUNDLE_PATH
  value: {{ include "mcp-gateway.postgresqlCaBundlePath" . | quote }}
{{- end }}
{{- end -}}

{{- define "mcp-gateway.postgresqlCaVolumeMount" -}}
{{- if .Values.postgresql.caBundle.enabled }}
- name: postgresql-ca
  mountPath: {{ .Values.postgresql.caBundle.mountPath | quote }}
  readOnly: true
{{- end }}
{{- end -}}

{{- define "mcp-gateway.postgresqlCaVolume" -}}
{{- if .Values.postgresql.caBundle.enabled }}
- name: postgresql-ca
  projected:
    defaultMode: 0444
    sources:
      {{- if and .Values.postgresql.caBundle.configMapKeyRef.name .Values.postgresql.caBundle.configMapKeyRef.key }}
      - configMap:
          name: {{ .Values.postgresql.caBundle.configMapKeyRef.name }}
          items:
            - key: {{ .Values.postgresql.caBundle.configMapKeyRef.key }}
              path: ca.crt
      {{- else }}
      - secret:
          name: {{ .Values.postgresql.caBundle.secretKeyRef.name }}
          items:
            - key: {{ .Values.postgresql.caBundle.secretKeyRef.key }}
              path: ca.crt
      {{- end }}
{{- end }}
{{- end -}}

{{/* Fail unless a URL satisfies the public HTTPS rules used by broker runtime config. */}}
{{- define "mcp-gateway.assertPublicHttpsUrl" -}}
{{- $name := .name -}}
{{- $value := .value -}}
{{- $allowQuery := .allowQuery | default false -}}
{{- $canonical := .canonical | default false -}}
{{- $routeSafe := .routeSafe | default false -}}
{{- $url := urlParse $value -}}
{{- if or (ne $url.scheme "https") (not $url.host) $url.userinfo $url.fragment (and (not $allowQuery) $url.query) -}}
{{- fail (printf "%s must be a clean public HTTPS URL" $name) -}}
{{- end -}}
{{- $authority := $url.host -}}
{{- $port := trimPrefix ":" (regexFind ":[0-9]+$" $authority) -}}
{{- if and $port (or (gt (len $port) 5) (gt (int $port) 65535) (and (gt (len $port) 1) (hasPrefix "0" $port))) -}}
{{- fail (printf "%s must use a valid canonical port" $name) -}}
{{- end -}}
{{- $unsafePath := regexMatch "(?i)https://[^/?#]+(?:/[^?#]*)?(?:/(?:[.]{1,2}|%2e(?:%2e)?)(?:/|$)|%2f|%5c|//)" $value -}}
{{- $unsafeRawCharacters := regexMatch "[^\\x21-\\x7e]|[\\x22\\x3c\\x3e\\x5c\\x5e\\x60\\x7b\\x7d]" $value -}}
{{- if and $canonical (or (ne $authority (lower $authority)) (eq $port "443") (not $url.path) $unsafePath $unsafeRawCharacters) -}}
{{- fail (printf "%s must be an exact canonical URL" $name) -}}
{{- end -}}
{{- if and $routeSafe (or $port (and (ne $url.path "/") (hasSuffix "/" $value))) -}}
{{- fail (printf "%s must use the canonical public ingress origin and a route-safe path" $name) -}}
{{- end -}}
{{- $hostname := regexReplaceAll ":[0-9]+$" (lower $authority) "" -}}
{{- if or (hasPrefix "[" $hostname) (contains ":" $hostname) -}}
{{- fail (printf "%s must use a public DNS name or IPv4 address" $name) -}}
{{- end -}}
{{- $ipv4 := "(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])" -}}
{{- $isIpv4 := regexMatch (printf "^%s\\.%s\\.%s\\.%s$" $ipv4 $ipv4 $ipv4 $ipv4) $hostname -}}
{{- $isDns := regexMatch "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$" $hostname -}}
{{- $isInvalidNumericHost := and (regexMatch "^[0-9.]+$" $hostname) (not $isIpv4) -}}
{{- $isPrivateName := or (eq $hostname "localhost") (hasSuffix ".localhost" $hostname) (hasSuffix ".local" $hostname) (hasSuffix ".internal" $hostname) (hasSuffix ".home.arpa" $hostname) -}}
{{- $isPrivateIpv4 := regexMatch "^(0|10|127)\\." $hostname -}}
{{- $isPrivateIpv4 = or $isPrivateIpv4 (regexMatch "^100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\." $hostname) -}}
{{- $isPrivateIpv4 = or $isPrivateIpv4 (regexMatch "^169\\.254\\." $hostname) -}}
{{- $isPrivateIpv4 = or $isPrivateIpv4 (regexMatch "^172\\.(1[6-9]|2[0-9]|3[01])\\." $hostname) -}}
{{- $isPrivateIpv4 = or $isPrivateIpv4 (regexMatch "^192\\.0\\." $hostname) -}}
{{- $isPrivateIpv4 = or $isPrivateIpv4 (regexMatch "^192\\.168\\." $hostname) -}}
{{- $isPrivateIpv4 = or $isPrivateIpv4 (regexMatch "^198\\.(18|19)\\." $hostname) -}}
{{- $isPrivateIpv4 = or $isPrivateIpv4 (regexMatch "^(22[4-9]|23[0-9]|24[0-9]|25[0-5])\\." $hostname) -}}
{{- if or (and (not $isIpv4) (not $isDns)) $isInvalidNumericHost $isPrivateName (and $isIpv4 $isPrivateIpv4) -}}
{{- fail (printf "%s must use a public hostname" $name) -}}
{{- end -}}
{{- end -}}

{{/* Fail unless an address matches node:net isIP plus runtime lowercase/trim normalization. */}}
{{- define "mcp-gateway.assertNormalizedIp" -}}
{{- $name := .name -}}
{{- $address := .value -}}
{{- if or (ne $address (trim $address)) (ne $address (lower $address)) (gt (len $address) 64) -}}
{{- fail (printf "%s must be an exact normalized IP literal" $name) -}}
{{- end -}}
{{- $ipv4 := "(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])" -}}
{{- if not (regexMatch (printf "^%s\\.%s\\.%s\\.%s$" $ipv4 $ipv4 $ipv4 $ipv4) $address) -}}
{{- $zoneParts := splitList "%" $address -}}
{{- if or (gt (len $zoneParts) 2) (and (eq (len $zoneParts) 2) (not (regexMatch "^[a-z0-9_.-]+$" (index $zoneParts 1)))) -}}
{{- fail (printf "%s must be an exact normalized IP literal" $name) -}}
{{- end -}}
{{- $base := index $zoneParts 0 -}}
{{- if not (contains ":" $base) -}}
{{- fail (printf "%s must be an exact normalized IP literal" $name) -}}
{{- end -}}
{{- $embeddedGroups := 0 -}}
{{- if contains "." $base -}}
{{- $embedded := regexFind "[0-9.]+$" $base -}}
{{- if not (regexMatch (printf "^%s\\.%s\\.%s\\.%s$" $ipv4 $ipv4 $ipv4 $ipv4) $embedded) -}}
{{- fail (printf "%s must be an exact normalized IP literal" $name) -}}
{{- end -}}
{{- $base = trimSuffix $embedded $base -}}
{{- if and (hasSuffix ":" $base) (not (hasSuffix "::" $base)) -}}
{{- $base = trimSuffix ":" $base -}}
{{- end -}}
{{- $embeddedGroups = 2 -}}
{{- end -}}
{{- $compressed := contains "::" $base -}}
{{- $halves := splitList "::" $base -}}
{{- if gt (len $halves) 2 -}}
{{- fail (printf "%s must be an exact normalized IP literal" $name) -}}
{{- end -}}
{{- $groups := $embeddedGroups -}}
{{- range $half := $halves -}}
{{- if $half -}}
{{- range $group := splitList ":" $half -}}
{{- if not (regexMatch "^[0-9a-f]{1,4}$" $group) -}}
{{- fail (printf "%s must be an exact normalized IP literal" $name) -}}
{{- end -}}
{{- $groups = add1 $groups -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if or (and $compressed (ge (int $groups) 8)) (and (not $compressed) (ne (int $groups) 8)) -}}
{{- fail (printf "%s must be an exact normalized IP literal" $name) -}}
{{- end -}}
{{- end -}}
{{- end -}}
