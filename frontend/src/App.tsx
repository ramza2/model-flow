import { NavLink, Route, Routes, useParams } from "react-router-dom";
import type { ReactNode } from "react";
import Dashboard from "./pages/Dashboard";
import Projects from "./pages/Projects";
import ProjectCreate from "./pages/ProjectCreate";
import ProjectOverview from "./pages/ProjectOverview";
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
import SystemStatusPage from "./pages/SystemStatus";

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <NavLink to="/" className="brand">
            Model<span>Flow</span>
          </NavLink>
          <div className="brand-sub">MLOps Workspace</div>
        </div>
        <nav className="nav">
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/projects">Projects</NavLink>
          <NavLink to="/system">System status</NavLink>
        </nav>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

function ProjectNav() {
  const { projectId } = useParams();
  const base = `/projects/${projectId}`;
  return (
    <div className="row-actions" style={{ marginBottom: "1rem" }}>
      <NavLink to={base}>Overview</NavLink>
      <NavLink to={`${base}/datasets`}>Datasets</NavLink>
      <NavLink to={`${base}/jobs`}>Training</NavLink>
      <NavLink to={`${base}/runs`}>Experiments</NavLink>
      <NavLink to={`${base}/models`}>Models</NavLink>
      <NavLink to={`${base}/endpoints`}>Endpoints</NavLink>
    </div>
  );
}

export default function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/new" element={<ProjectCreate />} />
        <Route
          path="/projects/:projectId"
          element={
            <>
              <ProjectNav />
              <ProjectOverview />
            </>
          }
        />
        <Route
          path="/projects/:projectId/datasets"
          element={
            <>
              <ProjectNav />
              <Datasets />
            </>
          }
        />
        <Route
          path="/projects/:projectId/datasets/:datasetId"
          element={
            <>
              <ProjectNav />
              <DatasetDetail />
            </>
          }
        />
        <Route
          path="/projects/:projectId/jobs"
          element={
            <>
              <ProjectNav />
              <Jobs />
            </>
          }
        />
        <Route
          path="/projects/:projectId/jobs/new"
          element={
            <>
              <ProjectNav />
              <JobCreate />
            </>
          }
        />
        <Route
          path="/projects/:projectId/jobs/:jobId"
          element={
            <>
              <ProjectNav />
              <JobDetail />
            </>
          }
        />
        <Route
          path="/projects/:projectId/runs"
          element={
            <>
              <ProjectNav />
              <Runs />
            </>
          }
        />
        <Route
          path="/projects/:projectId/runs/compare"
          element={
            <>
              <ProjectNav />
              <RunCompare />
            </>
          }
        />
        <Route
          path="/projects/:projectId/models"
          element={
            <>
              <ProjectNav />
              <Registry />
            </>
          }
        />
        <Route
          path="/projects/:projectId/models/:modelName/versions/:version"
          element={
            <>
              <ProjectNav />
              <ModelVersion />
            </>
          }
        />
        <Route
          path="/projects/:projectId/endpoints"
          element={
            <>
              <ProjectNav />
              <Endpoints />
            </>
          }
        />
        <Route
          path="/projects/:projectId/endpoints/:endpointId/predict"
          element={
            <>
              <ProjectNav />
              <Predict />
            </>
          }
        />
        <Route path="/system" element={<SystemStatusPage />} />
      </Routes>
    </Shell>
  );
}
