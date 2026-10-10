// MotoFix intentionally never auto-logs a user out due to inactivity.
// Sessions are kept alive until the user explicitly logs out or local storage is
// cleared by the app / device. Inactivity tracking is intentionally disabled.

export function markActivity(): void {
  // no-op: inactivity does not end sessions
}

export function startActivity(): void {
  // no-op: no idle timeout at any duration
}

export function expireIfInactive(): void {
  // no-op: inactivity must never clear motofix_sp_token / motofix_sp_user
}

export function wasInactivityLogout(): boolean {
  return false
}

export function clearInactivity(): void {
  // no-op: session expiry after inactivity is intentionally removed
}
