{{- define "mcp-gateway.name" -}}
{{- .Chart.Name -}}
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
