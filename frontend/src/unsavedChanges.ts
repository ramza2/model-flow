export const UNSAVED_CHANGES_MESSAGE =
  "Unsaved pipeline changes\n\nYour latest changes have not been saved as a pipeline version. Leave anyway?";

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
