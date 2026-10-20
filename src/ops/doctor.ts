import type { Paths } from '../paths.js';
import { loadPolicy, type Policy } from '../policy/schema.js';
import { summarizePolicy, type PolicySummary } from '../policy/summary.js';
import type { Runner } from '../wacli/runner.js';
import { getStatus, type StatusInfo } from '../wacli/status.js';
import { MIN_WACLI_VERSION } from '../version.js';
import { isInertEntry } from './policy-cmd.js';
import type { ServiceManager, ServiceStatus } from './service-types.js';

export interface DoctorReport {
  status: StatusInfo;
  wacli_bin: string;
  /** Null when the policy file could not be loaded; the reason is then in `problems`. */
  policy: PolicySummary | null;
  service: ServiceStatus | null;
  paths: { config_dir: string; data_dir: string; policy_file: string; audit_file: string; daemon_log: string };
  problems: string[];
}

export async function collectDoctor(opts: { runner: Runner; policyFile: string; paths: Paths; service: ServiceManager | null; now: () => Date }): Promise<DoctorReport> {
  const problems: string[] = [];
  let status: StatusInfo;
  try {
    status = await getStatus(opts.runner, opts.now());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    problems.push(message);
    status = {
      wacli_version: null, min_version_ok: false, authenticated: false, phone: null, connection_state: null, session_revoked: false,
      store_dir: null, last_sync_at: null, heartbeat_at: null, heartbeat_age_seconds: null, counts: { chats: null, messages: null },
    };
  }
  if (status.wacli_version !== null && !status.min_version_ok) {
    problems.push(`wacli ${status.wacli_version} is older than the minimum ${MIN_WACLI_VERSION}. Fix: brew upgrade wacli`);
  }
  if (status.wacli_version !== null && status.min_version_ok && !status.authenticated) {
    problems.push('WhatsApp is not paired. Run: whatsapp-agent setup');
  }
  if (status.session_revoked) {
    problems.push('WhatsApp revoked the linked session. Run: whatsapp-agent setup');
  }
  let policy: Policy | null = null;
  try {
    policy = await loadPolicy(opts.policyFile);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    problems.push(message.includes(opts.policyFile) ? message : `${opts.policyFile}: ${message}`);
  }
  for (const entry of policy?.writes.allow ?? []) {
    if (isInertEntry(entry)) {
      const quoted = entry.replace(/(["\\$`])/g, '\\$1');
      problems.push(`Allowlist entry "${entry}" is not a phone number or JID and never matches. Remove it with: whatsapp-agent policy remove "${quoted}", then add the person with: whatsapp-agent policy allow <number or JID>`);
    }
  }
  const service = opts.service ? await opts.service.status() : null;
  if (service && !service.installed) {
    problems.push('The sync daemon is not installed. Reads will go stale. Run: whatsapp-agent daemon install');
  } else if (service && service.running === false) {
    problems.push('The sync daemon is installed but not running. Restart it with: whatsapp-agent daemon install');
  }
  return {
    status,
    wacli_bin: opts.runner.bin,
    policy: policy ? summarizePolicy(policy) : null,
    service,
    paths: {
      config_dir: opts.paths.configDir, data_dir: opts.paths.dataDir, policy_file: opts.paths.policyFile,
      audit_file: opts.paths.auditFile, daemon_log: opts.paths.daemonLog,
    },
    problems,
  };
}

export function formatDoctor(r: DoctorReport): string {
  const s = r.status;
  const lines = [
    `wacli: ${s.wacli_version ?? 'not found'} (${r.wacli_bin})${s.wacli_version && !s.min_version_ok ? ' below minimum' : ''}`,
    `paired: ${s.authenticated ? `yes${s.phone ? ` (${s.phone})` : ''}` : 'no'}`,
    `connection: ${s.connection_state ?? 'unknown'}`,
    `last sync: ${s.last_sync_at ?? 'unknown'}`,
    `last activity: ${s.heartbeat_at ? `${s.heartbeat_at} (${s.heartbeat_age_seconds}s ago)` : 'none'}`,
    `daemon service: ${r.service ? r.service.detail : 'not supported on this platform'}`,
    `store: ${s.store_dir ?? 'unknown'} (${s.counts.chats ?? '?'} chats, ${s.counts.messages ?? '?'} messages)`,
    r.policy
      ? `writes: ${r.policy.writes_enabled ? 'enabled' : 'disabled'}, confirm: ${r.policy.confirm}, allowlist: ${r.policy.allow_count}, groups: ${r.policy.groups_enabled ? 'on' : 'off'}, file roots: ${r.policy.file_roots_count}`
      : 'writes: unknown (the policy file could not be loaded)',
    `config: ${r.paths.policy_file}`,
    `audit: ${r.paths.audit_file}`,
    `daemon log: ${r.paths.daemon_log}`,
  ];
  if (r.problems.length > 0) {
    lines.push('', 'Problems:');
    for (const p of r.problems) lines.push(`  - ${p}`);
  } else {
    lines.push('', 'No problems found.');
  }
  return lines.join('\n') + '\n';
}
