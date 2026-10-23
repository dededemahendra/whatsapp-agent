import type { ConfirmMode, Policy } from './schema.js';

export interface PolicySummary {
  writes_enabled: boolean;
  confirm: ConfirmMode;
  allow_count: number;
  groups_enabled: boolean;
  file_roots_count: number;
  account: string | null;
}

export function summarizePolicy(p: Policy): PolicySummary {
  return {
    writes_enabled: p.writes.enabled,
    confirm: p.writes.confirm,
    allow_count: p.writes.allow.length,
    groups_enabled: p.writes.groups,
    file_roots_count: p.writes.fileRoots.length,
    account: p.account,
  };
}
