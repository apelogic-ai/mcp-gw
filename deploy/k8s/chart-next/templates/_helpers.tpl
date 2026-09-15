{{- define "mcp-gateway.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "mcp-gateway.fullname" -}}
{{- default .Release.Name .Values.fullnameOverride -}}
{{- end -}}

{{/* DNS-1035-bounded component name; long fullnames retain a stable identity hash. */}}
{{- define "mcp-gateway.componentName" -}}
{{- $component := .component | toString -}}
{{- $fullname := include "mcp-gateway.fullname" .root -}}
{{- if not (regexMatch "^[a-z]" $fullname) -}}
{{- fail "the MCP-GW fullname must start with an alphabetic character so generated Service names satisfy Kubernetes DNS-1035 validation" -}}
{{- end -}}
{{- $plainName := printf "%s-%s" $fullname $component -}}
{{- if le (len $plainName) 63 -}}
{{- $plainName | trimSuffix "-" -}}
{{- else -}}
{{- $hash := sha256sum $fullname | trunc 8 -}}
{{- $prefixLimit := sub 53 (len $component) | int -}}
{{- if lt $prefixLimit 1 -}}
{{- fail (printf "component name %q is too long for a Kubernetes DNS label" $component) -}}
{{- end -}}
{{- $prefix := $fullname | trunc $prefixLimit | trimSuffix "-" -}}
{{- printf "%s-%s-%s" $prefix $hash $component | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "mcp-gateway.labels" -}}
app.kubernetes.io/name: {{ include "mcp-gateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "mcp-gateway.selectorLabels" -}}
app.kubernetes.io/name: {{ include "mcp-gateway.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "mcp-gateway.serviceAccountName" -}}
{{- if .values.serviceAccount.name -}}
{{- .values.serviceAccount.name -}}
{{- else -}}
{{- include "mcp-gateway.componentName" (dict "root" .root "component" .component) -}}
{{- end -}}
{{- end -}}

{{- define "mcp-gateway.image" -}}
{{- $image := .image -}}
{{- if $image.digest -}}
{{- printf "%s@%s" (required "image.repository is required when a component is enabled" $image.repository) $image.digest -}}
{{- else -}}
{{- printf "%s:%s" (required "image.repository is required when a component is enabled" $image.repository) ($image.tag | default .root.Chart.AppVersion) -}}
{{- end -}}
{{- end -}}

{{/* Every component reads secrets.name unless it names its own Secret. */}}
{{- define "mcp-gateway.secretName" -}}
{{- $override := "" -}}
{{- if .values.secretRef -}}
{{- $override = .values.secretRef.name -}}
{{- end -}}
{{- default .root.Values.secrets.name $override -}}
{{- end -}}

{{- define "mcp-gateway.postgresqlCaPath" -}}
{{- printf "%s/ca.crt" (trimSuffix "/" .Values.postgresql.caBundle.mountPath) -}}
{{- end -}}

{{- define "mcp-gateway.postgresqlCaVolume" -}}
name: postgresql-ca
projected:
  defaultMode: 0444
  sources:
    {{- $ca := .Values.postgresql.caBundle }}
    {{- if $ca.configMapKeyRef.name }}
    - configMap:
        name: {{ $ca.configMapKeyRef.name }}
        items:
          - key: {{ $ca.configMapKeyRef.key }}
            path: ca.crt
    {{- else }}
    - secret:
        name: {{ $ca.secretKeyRef.name }}
        items:
          - key: {{ $ca.secretKeyRef.key }}
            path: ca.crt
    {{- end }}
{{- end -}}
