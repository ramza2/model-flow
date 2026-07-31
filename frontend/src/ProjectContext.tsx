import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api, type Project } from "./api";

const PROJECT_KEY = "modelflow_project_id";

type ProjectValue = {
  projects: Project[];
  selectedProject: Project | null;
  loading: boolean;
  error: string;
  selectProject: (id: number | null) => void;
  refreshProjects: () => Promise<Project[]>;
};

const ProjectContext = createContext<ProjectValue | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const stored = localStorage.getItem(PROJECT_KEY);
    return stored ? Number(stored) : null;
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refreshProjects = useCallback(async () => {
    setError("");
    try {
      const rows = await api<Project[]>("/projects");
      setProjects(rows);
      setSelectedId((current) => {
        if (current && rows.some((project) => project.id === current)) return current;
        const next = rows[0]?.id ?? null;
        if (next) localStorage.setItem(PROJECT_KEY, String(next));
        else localStorage.removeItem(PROJECT_KEY);
        return next;
      });
      return rows;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Projects could not be loaded.");
      throw reason;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshProjects().catch(() => undefined);
  }, [refreshProjects]);

  const selectProject = useCallback((id: number | null) => {
    setSelectedId(id);
    if (id === null) localStorage.removeItem(PROJECT_KEY);
    else localStorage.setItem(PROJECT_KEY, String(id));
  }, []);

  const value = useMemo(
    () => ({
      projects,
      selectedProject: projects.find((project) => project.id === selectedId) ?? null,
      loading,
      error,
      selectProject,
      refreshProjects,
    }),
    [error, loading, projects, refreshProjects, selectProject, selectedId],
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject() {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("useProject must be used within ProjectProvider");
  return value;
}

export function hasProjectAdminRole(project: Project | null) {
  return project?.role === "project_admin";
}
