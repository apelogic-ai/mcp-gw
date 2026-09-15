{{/* Renders every object belonging to one component. Component-agnostic. */}}
{{- define "mcp-gateway.workload" -}}
{{- $root := .root -}}
{{- $key := .key -}}
{{- $v := index $root.Values $key -}}
{{- $spec := include "mcp-gateway.componentSpec" (dict "root" $root "key" $key) | fromYaml -}}
{{- $component := $spec.name -}}
{{- $name := include "mcp-gateway.componentName" (dict "root" $root "component" $component) -}}
{{- $selector := include "mcp-gateway.selectorLabels" (dict "root" $root "component" $component) -}}
{{- if $v.serviceAccount.create }}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ include "mcp-gateway.serviceAccountName" (dict "root" $root "component" $component "values" $v) }}
  labels:
    {{- include "mcp-gateway.labels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ $component }}
  {{- with $v.serviceAccount.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
---
{{- end }}
apiVersion: v1
kind: Service
metadata:
  name: {{ $name }}
  labels:
    {{- include "mcp-gateway.labels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ $component }}
spec:
  type: {{ $v.service.type }}
  selector:
    {{- $selector | nindent 4 }}
  ports:
    - name: http
      port: {{ $v.port }}
      targetPort: http
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $name }}
  labels:
    {{- include "mcp-gateway.labels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ $component }}
spec:
  {{- if not $v.hpa.enabled }}
  replicas: {{ $v.replicas }}
  {{- end }}
  revisionHistoryLimit: {{ $v.revisionHistoryLimit }}
  selector:
    matchLabels:
      {{- $selector | nindent 6 }}
  template:
    metadata:
      {{- with $spec.podAnnotations }}
      annotations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      labels:
        {{- $selector | nindent 8 }}
    spec:
      serviceAccountName: {{ include "mcp-gateway.serviceAccountName" (dict "root" $root "component" $component "values" $v) }}
      automountServiceAccountToken: {{ $v.automountServiceAccountToken }}
      {{- with $root.Values.global.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      securityContext:
        {{- toYaml $spec.podSecurityContext | nindent 8 }}
      {{- with $v.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $v.affinity }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $v.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with $v.topologySpreadConstraints }}
      topologySpreadConstraints:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      containers:
        - name: {{ $component }}
          image: {{ include "mcp-gateway.image" (dict "root" $root "image" $v.image) }}
          imagePullPolicy: {{ $root.Values.global.imagePullPolicy }}
          securityContext:
            {{- toYaml $v.securityContext | nindent 12 }}
          {{- with $spec.args }}
          args:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          ports:
            - name: http
              containerPort: {{ $v.port }}
          {{- with $spec.envFrom }}
          envFrom:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          {{- with $spec.env }}
          env:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          {{- if $v.probes.liveness.enabled }}
          livenessProbe:
            {{- omit $v.probes.liveness "enabled" | toYaml | nindent 12 }}
          {{- end }}
          {{- if $v.probes.readiness.enabled }}
          readinessProbe:
            {{- omit $v.probes.readiness "enabled" | toYaml | nindent 12 }}
          {{- end }}
          {{- with $spec.volumeMounts }}
          volumeMounts:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          {{- with $v.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
      {{- with $spec.volumes }}
      volumes:
        {{- toYaml . | nindent 8 }}
      {{- end }}
{{- if $v.hpa.enabled }}
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ $name }}
  labels:
    {{- include "mcp-gateway.labels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ $component }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ $name }}
  minReplicas: {{ $v.hpa.minReplicas }}
  maxReplicas: {{ $v.hpa.maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ $v.hpa.targetCPUUtilizationPercentage }}
{{- end }}
{{- if $v.pdb.enabled }}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ $name }}
  labels:
    {{- include "mcp-gateway.labels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ $component }}
spec:
  minAvailable: {{ $v.pdb.minAvailable }}
  selector:
    matchLabels:
      {{- $selector | nindent 6 }}
{{- end }}
{{- if $root.Values.networkPolicy.enabled }}
{{- $np := $root.Values.networkPolicy }}
{{- $publicFacing := has $component (list "agentgateway" "google-workspace" "github-wrapper") }}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ $name }}
  labels:
    {{- include "mcp-gateway.labels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ $component }}
spec:
  podSelector:
    matchLabels:
      {{- $selector | nindent 6 }}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: {{ include "mcp-gateway.name" $root }}
              app.kubernetes.io/instance: {{ $root.Release.Name }}
      ports:
        - protocol: TCP
          port: {{ $v.port }}
    {{- if $publicFacing }}
    - from:
        {{- if $np.ingressSourceCidrs }}
        {{- range $np.ingressSourceCidrs }}
        - ipBlock:
            cidr: {{ . }}
        {{- end }}
        {{- else }}
        - namespaceSelector:
            matchLabels:
              {{- toYaml $np.ingressControllerPeer.namespaceSelector.matchLabels | nindent 14 }}
          podSelector:
            matchLabels:
              {{- toYaml $np.ingressControllerPeer.podSelector.matchLabels | nindent 14 }}
        {{- end }}
      ports:
        - protocol: TCP
          port: {{ $v.port }}
    {{- end }}
{{- end }}
{{- end -}}
