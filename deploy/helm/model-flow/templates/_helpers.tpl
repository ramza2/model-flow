{{- define "model-flow.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "model-flow.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "model-flow.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "model-flow.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "model-flow.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "model-flow.selectorLabels" -}}
app.kubernetes.io/name: {{ include "model-flow.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "model-flow.secretName" -}}
{{- required "secret.existingSecret is required" .Values.secret.existingSecret -}}
{{- end }}

{{- define "model-flow.image" -}}
{{- if .digest -}}
{{- printf "%s@%s" .repository .digest -}}
{{- else -}}
{{- printf "%s:%s" .repository .tag -}}
{{- end -}}
{{- end }}
{{- define "model-flow.mlflowArtifactRoot" -}}
{{- if .Values.mlflow.artifactRoot -}}
{{- .Values.mlflow.artifactRoot -}}
{{- else -}}
{{- printf "s3://%s/" .Values.external.objectStore.buckets.mlflow -}}
{{- end -}}
{{- end }}

