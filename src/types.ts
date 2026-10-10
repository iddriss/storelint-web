/** The Report JSON contract shared by the StoreLint CLI, web app and MCP server. */

export type Framework = 'flutter' | 'react-native' | 'expo' | 'unknown';
export type Platform = 'android' | 'ios' | 'both';
export type Severity = 'blocker' | 'warning' | 'info';

export interface Finding {
  /** Stable kebab id, namespaced: android.*, ios.*, app.* */
  id: string;
  platform: Platform;
  severity: Severity;
  title: string;
  detail: string;
  file?: string;
  line?: number;
  fix: string;
  docs?: string;
}

export interface Report {
  schemaVersion: 1;
  scannedAt: string;
  project: { path: string; framework: Framework; name: string };
  summary: { blocker: number; warning: number; info: number; score: number };
  findings: Finding[];
}

export const SEVERITIES: Severity[] = ['blocker', 'warning', 'info'];

/** score = 100 - 25*blockers - 5*warnings, floored at 0 */
export function computeScore(blockers: number, warnings: number): number {
  return Math.max(0, 100 - 25 * blockers - 5 * warnings);
}
