export const UNSAVED_CHANGES_MESSAGE =
  "저장되지 않은 파이프라인 변경사항\n\n최신 변경사항이 파이프라인 버전으로 저장되지 않았습니다. 그래도 나가시겠습니까?";

let active = false;

export function setUnsavedChangesActive(next: boolean): void {
  active = next;
}

export function hasUnsavedChanges(): boolean {
  return active;
}

export function confirmUnsavedNavigation(
  confirmFn: (message: string) => boolean = (message) => window.confirm(message),
): boolean {
  if (!active) return true;
  return confirmFn(UNSAVED_CHANGES_MESSAGE);
}

export function shouldGuardAnchorNavigation(
  anchor: HTMLAnchorElement,
  currentLocation: Pick<Location, "origin" | "pathname" | "search"> = window.location,
): boolean {
  if (!active) return false;
  if (anchor.target && anchor.target !== "_self") return false;
  if (anchor.hasAttribute("download")) return false;
  if (anchor.classList.contains("pipeline-back-link")) return false;

  const target = new URL(anchor.href, currentLocation.origin);
  if (target.origin !== currentLocation.origin) return false;
  if (target.pathname === currentLocation.pathname && target.search === currentLocation.search) {
    return false;
  }
  return true;
}
