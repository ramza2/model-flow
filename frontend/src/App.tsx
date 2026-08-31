import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import AppShell from "./AppShell";
import { LoginPage, ProtectedRoute, useAuth } from "./AuthContext";
import { ProjectProvider } from "./ProjectContext";
import Dashboard from "./pages/Dashboard";
import Projects from "./pages/Projects";
import ProjectCreate from "./pages/ProjectCreate";
import ProjectOverview from "./pages/ProjectOverview";
import DataSources from "./pages/DataSources";
import Datasets from "./pages/Datasets";
import DatasetDetail from "./pages/DatasetDetail";
import JobCreate from "./pages/JobCreate";
import Jobs from "./pages/Jobs";
import JobDetail from "./pages/JobDetail";
import Runs from "./pages/Runs";
import RunCompare from "./pages/RunCompare";
import Registry from "./pages/Registry";
import ModelVersion from "./pages/ModelVersion";
import Endpoints from "./pages/Endpoints";
import Predict from "./pages/Predict";
import DeploymentApiUsage from "./pages/DeploymentApiUsage";
import BatchInference from "./pages/BatchInference";
import Schedules from "./pages/Schedules";
import { PipelineBuilder, PipelineRunDetail, Pipelines } from "./pages/Pipelines";
import Monitoring from "./pages/Monitoring";
import Alerts from "./pages/Alerts";
import AuditLogs from "./pages/AuditLogs";
import Administration from "./pages/Administration";
import ChangePassword from "./pages/ChangePassword";

function AdminRoute({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return user?.is_system_admin ? children : <Navigate to="/" replace />;
}

function ProductRoutes() {
  return <Routes>
    <Route path="/" element={<Dashboard />} />
    <Route path="/projects" element={<Projects />} />
    <Route path="/projects/new" element={<ProjectCreate />} />
    <Route path="/projects/:projectId" element={<ProjectOverview />} />
    <Route path="/projects/:projectId/data-sources" element={<DataSources />} />
    <Route path="/projects/:projectId/datasets" element={<Datasets />} />
    <Route path="/projects/:projectId/datasets/:datasetId" element={<DatasetDetail />} />
    <Route path="/projects/:projectId/experiments" element={<Runs />} />
    <Route path="/projects/:projectId/experiments/compare" element={<RunCompare />} />
    <Route path="/projects/:projectId/jobs" element={<Jobs />} />
    <Route path="/projects/:projectId/jobs/new" element={<JobCreate />} />
    <Route path="/projects/:projectId/jobs/:jobId" element={<JobDetail />} />
    <Route path="/projects/:projectId/pipelines" element={<Pipelines />} />
    <Route path="/projects/:projectId/pipelines/:pipelineId" element={<PipelineBuilder />} />
    <Route path="/projects/:projectId/pipeline-runs/:runId" element={<PipelineRunDetail />} />
    <Route path="/projects/:projectId/schedules" element={<Schedules />} />
    <Route path="/projects/:projectId/models" element={<Registry />} />
    <Route path="/projects/:projectId/models/:modelVersionId" element={<ModelVersion />} />
    <Route path="/projects/:projectId/deployments" element={<Endpoints />} />
    <Route path="/projects/:projectId/deployments/batch" element={<BatchInference />} />
    <Route path="/projects/:projectId/deployments/:endpointId/predict" element={<Predict />} />
    <Route path="/projects/:projectId/deployments/:endpointId/api" element={<DeploymentApiUsage />} />
    <Route path="/projects/:projectId/monitoring" element={<Monitoring />} />
    <Route path="/projects/:projectId/alerts" element={<Alerts />} />
    <Route path="/projects/:projectId/audit" element={<AuditLogs />} />
    <Route path="/audit" element={<AdminRoute><AuditLogs /></AdminRoute>} />
    <Route path="/admin" element={<AdminRoute><Administration /></AdminRoute>} />
    <Route path="/password" element={<ChangePassword />} />
    <Route path="*" element={<div className="empty-state"><h1>Page not found</h1><p>The page you requested does not exist.</p></div>} />
  </Routes>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/*" element={
        <ProtectedRoute>
          <ProjectProvider>
            <AppShell><ProductRoutes /></AppShell>
          </ProjectProvider>
        </ProtectedRoute>
      } />
    </Routes>
  );
}
