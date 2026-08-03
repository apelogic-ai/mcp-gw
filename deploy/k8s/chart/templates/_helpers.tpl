{{- define "mcp-gateway.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "mcp-gateway.hop1IssuersJson" -}}
{{- $profiles := list -}}
{{- range $index, $issuer := . -}}
{{- $profile := dict "name" $issuer.name "issuer" $issuer.issuer "jwksUrl" $issuer.jwksUrl "audiences" $issuer.audiences "emailClaim" ($issuer.emailClaim | default "email") "subjectClaim" ($issuer.subjectClaim | default "sub") -}}
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
{{- printf "%s@%s" $image.repository $image.digest -}}
{{- else -}}
{{- printf "%s:%s" $image.repository ($image.tag | default .root.Chart.AppVersion) -}}
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
