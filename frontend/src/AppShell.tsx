import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { api, type Alert } from "./api";
import { useAuth } from "./AuthContext";
import { hasProjectAdminRole, useProject } from "./ProjectContext";
import {
  confirmUnsavedNavigation,
  shouldGuardAnchorNavigation,
} from "./unsavedChanges";

type NavItem = { label: string; to: string; icon: string; end?: boolean; hint?: string };
type ProjectNavItem = { label: string; path: string; icon: string; end?: boolean; hint?: string };

const DRAWER_MEDIA_QUERY = "(max-width: 1023px)";

const projectGroups: { label: string; items: ProjectNavItem[] }[] = [
  {
    label: "데이터",
    items: [
      { label: "데이터 소스", path: "data-sources", icon: "⌁", hint: "외부 API, DB, 파일 등 원천 데이터를 ModelFlow에 연결합니다." },
      { label: "데이터셋", path: "datasets", icon: "▤", hint: "수집하거나 가공한 버전별 데이터를 확인하고 학습에 사용합니다." },
      { label: "데이터 가공", path: "preparations", icon: "⧉", hint: "필터, 조인, 파생변수 등 학습 전 데이터 변환을 구성합니다." },
      { label: "피드백", path: "feedback", icon: "☑", hint: "예측 결과에 대한 사용자 피드백을 확인합니다." },
    ],
  },
  {
    label: "모델 개발",
    items: [
      { label: "파이프라인", path: "pipelines", icon: "⌘", hint: "데이터 처리와 학습 작업을 순서대로 연결해 반복 실행합니다." },
      { label: "모델 학습", path: "jobs", icon: "▶", hint: "데이터를 선택해 모델을 학습하고 검증·테스트 성능을 확인합니다." },
      { label: "실험 비교", path: "experiments", icon: "⌇", hint: "여러 학습 실행의 설정과 성능 지표를 비교합니다." },
    ],
  },
  {
    label: "모델 운영",
    items: [
      { label: "모델 관리", path: "models", icon: "◆", hint: "학습된 모델의 버전, 검증, 승인, 운영 상태를 관리합니다." },
      { label: "모델 배포", path: "deployments", icon: "↗", hint: "승인된 모델을 예측 API로 사용할 수 있도록 배포합니다." },
    ],
  },
  {
    label: "운영 관리",
    items: [
      { label: "스케줄", path: "schedules", icon: "⏱", hint: "반복 실행 일정과 상태를 관리합니다." },
      { label: "모니터링", path: "monitoring", icon: "◉", hint: "배포 모델과 예측 서비스의 상태를 확인합니다." },
      { label: "품질 정책", path: "model-quality/policies", icon: "▤", hint: "모델 승인에 사용할 품질 기준을 관리합니다." },
      { label: "알림", path: "alerts", icon: "⚑", hint: "운영 중 발생한 경고와 확인이 필요한 항목을 봅니다." },
    ],
  },
];

const crumbLabels: Record<string, string> = {
  projects: "프로젝트",
  "data-sources": "데이터 소스",
  datasets: "데이터셋",
  preparations: "데이터 가공",
  feedback: "피드백",
  experiments: "실험 비교",
  jobs: "모델 학습",
  pipelines: "파이프라인",
  schedules: "스케줄",
  "pipeline-runs": "파이프라인 실행",
  models: "모델 관리",
  deployments: "모델 배포",
  predict: "예측 테스트",
  batch: "일괄 예측",
  monitoring: "모니터링",
  "model-quality": "모델 품질",
  policies: "품질 정책",
  alerts: "알림",
  audit: "감사 로그",
  admin: "시스템 관리",
  password: "비밀번호 변경",
  new: "만들기",
  compare: "비교",
  runs: "실행",
  api: "API 사용",
};

function Breadcrumbs() {
  const location = useLocation();
  const { projects } = useProject();
  const segments = location.pathname.split("/").filter(Boolean);
  const crumbs = segments.map((segment, index) => {
    const path = `/${segments.slice(0, index + 1).join("/")}`;
    let label = crumbLabels[segment];
    if (segment === "audit" && !segments.includes("projects")) {
      label = "전체 감사 로그";
    }
    if (!label && segments[index - 1] === "projects") {
      label = projects.find((project) => String(project.id) === segment)?.name || "프로젝트";
    }
    if (!label && /^\d+$/.test(segment)) label = `#${segment}`;
    return { path, label: label || segment };
  });
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <Link to="/">홈</Link>
      {crumbs.map((crumb, index) => (
        <span key={crumb.path}>
          <span aria-hidden="true">/</span>
          {index === crumbs.length - 1 ? (
            <span aria-current="page" className="breadcrumb-current">{crumb.label}</span>
          ) : (
            <Link to={crumb.path}>{crumb.label}</Link>
          )}
        </span>
      ))}
    </nav>
  );
}

function NavItemLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  return (
    <NavLink to={item.to} end={item.end} onClick={onNavigate} title={item.hint}>
      <span className="nav-icon" aria-hidden="true">{item.icon}</span>
      <span className="nav-text">{item.label}</span>
    </NavLink>
  );
}

function useDrawerViewport() {
  const [isDrawerViewport, setIsDrawerViewport] = useState(() => (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(DRAWER_MEDIA_QUERY).matches
      : false
  ));

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia(DRAWER_MEDIA_QUERY);
    const sync = () => setIsDrawerViewport(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  return isDrawerViewport;
}

export default function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const {
    projects,
    selectedProject,
    selectProject,
    loading: projectsLoading,
  } = useProject();
  const navigate = useNavigate();
  const location = useLocation();
  const [unread, setUnread] = useState(0);
  const [navOpen, setNavOpen] = useState(false);
  const [projectPickerKey, setProjectPickerKey] = useState(0);
  const isDrawerViewport = useDrawerViewport();
  const sidebarRef = useRef<HTMLElement | null>(null);
  const navToggleRef = useRef<HTMLButtonElement | null>(null);
  const projectBase = selectedProject ? `/projects/${selectedProject.id}` : "";
  const canProjectAudit = Boolean(selectedProject) && (user?.is_system_admin || hasProjectAdminRole(selectedProject));
  const drawerClosed = isDrawerViewport && !navOpen;

  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!isDrawerViewport) {
      setNavOpen(false);
    }
  }, [isDrawerViewport]);

  useEffect(() => {
    if (!selectedProject) {
      setUnread(0);
      return;
    }
    api<Alert[]>(`/projects/${selectedProject.id}/alerts?is_read=false&is_resolved=false`)
      .then((alerts) => setUnread(alerts.length))
      .catch(() => setUnread(0));
  }, [selectedProject]);

  useEffect(() => {
    function guardLinkNavigation(event: MouseEvent) {
      if (
        event.defaultPrevented
        || event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
        || event.altKey
      ) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (!shouldGuardAnchorNavigation(anchor)) return;
      if (confirmUnsavedNavigation()) return;
      event.preventDefault();
      event.stopPropagation();
    }

    document.addEventListener("click", guardLinkNavigation, true);
    return () => document.removeEventListener("click", guardLinkNavigation, true);
  }, []);

  // Remove inert before the focus-transfer effect runs. Real browsers block
  // focus inside inert subtrees; effect order is the synchronization point.
  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) {
      return;
    }
    if (drawerClosed) {
      sidebar.setAttribute("inert", "");
    } else {
      sidebar.removeAttribute("inert");
    }
  }, [drawerClosed]);

  useEffect(() => {
    if (!isDrawerViewport || !navOpen) {
      return;
    }

    // Wait until after the toggle click/default focus lifecycle completes;
    // queueMicrotask still lost to Chrome's button focus retention.
    const frameId = window.requestAnimationFrame(() => {
      const sidebar = sidebarRef.current;
      if (!sidebar || sidebar.hasAttribute("inert")) {
        return;
      }

      const focusTarget =
        sidebar.querySelector<HTMLElement>("a[href], button:not([disabled])")
        ?? sidebar;

      focusTarget.focus();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [navOpen, isDrawerViewport]);

  useEffect(() => {
    if (!isDrawerViewport || !navOpen) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      // Focus toggle before aria-hidden/inert on the closing render.
      navToggleRef.current?.focus();
      setNavOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navOpen, isDrawerViewport]);

  async function signOut() {
    if (!confirmUnsavedNavigation()) return;
    await logout();
    navigate("/login", { replace: true });
  }

  function closeNav(options?: { restoreFocus?: boolean }) {
    const sidebar = sidebarRef.current;
    const activeElement = document.activeElement;
    const focusInsideSidebar =
      activeElement instanceof HTMLElement
      && Boolean(sidebar?.contains(activeElement));

    // Move focus out before aria-hidden/inert apply on the closing render.
    if (isDrawerViewport && (options?.restoreFocus || focusInsideSidebar)) {
      navToggleRef.current?.focus();
    }

    setNavOpen(false);
  }

  return (
    <div className={`app-frame${navOpen ? " nav-open" : ""}`}>
      <header className="topbar">
        <button
          ref={navToggleRef}
          type="button"
          className="nav-toggle"
          aria-label={navOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={navOpen}
          aria-controls="app-sidebar"
          onClick={() => setNavOpen((open) => !open)}
        >
          <span aria-hidden="true">{navOpen ? "✕" : "☰"}</span>
        </button>
        <Link to="/" className="brand" onClick={() => closeNav()}>
          Model<span>Flow</span>
        </Link>
        <div className="project-picker">
          <label htmlFor="project-select">프로젝트</label>
          <select
            key={projectPickerKey}
            id="project-select"
            value={selectedProject?.id ?? ""}
            disabled={projectsLoading || projects.length === 0}
            onChange={(event) => {
              const id = Number(event.target.value);
              if (!confirmUnsavedNavigation()) {
                setProjectPickerKey((version) => version + 1);
                return;
              }
              selectProject(id);
              navigate(`/projects/${id}`);
            }}
          >
            {projects.length === 0 && <option value="">프로젝트 없음</option>}
            {projects.map((project) => (
              <option value={project.id} key={project.id}>{project.name}</option>
            ))}
          </select>
        </div>
        <div className="top-actions">
          <Link
            className="icon-button"
            to={selectedProject ? `${projectBase}/alerts` : "/projects"}
            aria-label={`${unread} unread alerts`}
          >
            <span aria-hidden="true">♢</span>
            {unread > 0 && <span className="notification-count">{unread > 99 ? "99+" : unread}</span>}
          </Link>
          <details className="user-menu">
            <summary>
              <span className="avatar">{(user?.full_name || user?.email || "U").slice(0, 1).toUpperCase()}</span>
              <span className="user-copy">
                <strong>{user?.full_name || "ModelFlow user"}</strong>
                <small>{user?.is_system_admin ? "시스템 관리자" : user?.email}</small>
              </span>
            </summary>
            <div className="menu-popover">
              <div className="menu-email">{user?.email}</div>
              <Link to="/password">비밀번호 변경</Link>
              <button type="button" onClick={signOut}>로그아웃</button>
            </div>
          </details>
        </div>
      </header>

      {navOpen && isDrawerViewport && (
        <button
          type="button"
          className="nav-backdrop"
          aria-label="Dismiss navigation overlay"
          onClick={() => closeNav({ restoreFocus: true })}
        />
      )}

      <aside
        ref={sidebarRef}
        className="sidebar"
        id="app-sidebar"
        tabIndex={-1}
        aria-hidden={drawerClosed || undefined}
      >
        <nav className="nav" aria-label="Main navigation">
          <div className="nav-group">
            <span className="nav-label">작업공간</span>
            <NavItemLink item={{ label: "홈", to: "/", icon: "⌂", end: true, hint: "ModelFlow 전체 현황으로 이동합니다." }} onNavigate={() => closeNav()} />
            <NavItemLink item={{ label: "프로젝트", to: "/projects", icon: "▦", end: true, hint: "프로젝트를 만들거나 선택합니다." }} onNavigate={() => closeNav()} />
          </div>

          <div className="nav-group">
            <span className="nav-label">프로젝트</span>
            {!selectedProject && <p className="nav-hint">계속하려면 프로젝트를 선택하거나 새로 만드세요.</p>}
            {selectedProject && (
              <NavItemLink
                item={{ label: "개요", to: projectBase, icon: "◎", end: true, hint: "현재 프로젝트의 주요 현황을 확인합니다." }}
                onNavigate={() => closeNav()}
              />
            )}
          </div>

          {selectedProject && projectGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-label">{group.label}</span>
              {group.items.map((item) => (
                <NavItemLink
                  key={item.path}
                  item={{ label: item.label, to: `${projectBase}/${item.path}`, icon: item.icon, end: item.end, hint: item.hint }}
                  onNavigate={() => closeNav()}
                />
              ))}
            </div>
          ))}

          {canProjectAudit && (
            <div className="nav-group">
              <span className="nav-label">거버넌스</span>
              <NavItemLink
                item={{ label: "감사 로그", to: `${projectBase}/audit`, icon: "≡", hint: "프로젝트의 주요 변경과 작업 이력을 확인합니다." }}
                onNavigate={() => closeNav()}
              />
            </div>
          )}

          {user?.is_system_admin && (
            <div className="nav-group">
              <span className="nav-label">시스템</span>
              <NavItemLink
                item={{ label: "전체 감사 로그", to: "/audit", icon: "☷", hint: "전체 프로젝트의 감사 이력을 확인합니다." }}
                onNavigate={() => closeNav()}
              />
              <NavItemLink
                item={{ label: "시스템 관리", to: "/admin", icon: "⚙", hint: "사용자와 시스템 설정을 관리합니다." }}
                onNavigate={() => closeNav()}
              />
            </div>
          )}
        </nav>
        <div className="sidebar-foot">
          <span className="status-dot" /> ModelFlow 연결됨
        </div>
      </aside>

      <main className="content">
        <Breadcrumbs />
        {children}
      </main>
    </div>
  );
}
