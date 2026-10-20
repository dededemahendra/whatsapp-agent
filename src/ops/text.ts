/** Removes C0 and C1 control characters (and DEL), which can steer a terminal, from text that other people wrote. */
export function stripControls(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

/** An age in seconds as its largest whole unit: 45s, 5m, 3h or 2d. */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
