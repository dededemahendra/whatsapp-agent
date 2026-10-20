/** Removes C0 and C1 control characters (and DEL), which can steer a terminal, from text that other people wrote. */
export function stripControls(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}
