import { accessSync, constants, existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMemoryPath, getDbPath } from './memory.js';
import { loadProjectPolicy } from './project-policy.js';
import {
  getReceiptsDir,
  RECEIPT_STORE_LOCK_FILE,
  verifyReceiptChain,
} from './receipts.js';
import { getSessionPaths, parseSessionData } from './session.js';
import { TelemetryStore } from './providers/telemetry.js';
import {
  inspectTransactionJournals,
  recoverInterruptedTransactions,
  type TransactionInspection,
} from './transaction-journal.js';
import { resolveWorkspace, type WorkspaceInput } from './workspace.js';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  detail: string;
  repaired?: boolean;
}

export interface DoctorReport {
  tool: 'mythos-doctor';
  generatedAt: string;
  workspace: string;
  projectId: string;
  repairRequested: boolean;
  repaired: number;
  ok: boolean;
  exitCode: 0 | 1 | 2;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  workspace?: WorkspaceInput;
  repair?: boolean;
}

/** Run deterministic local health checks without contacting any provider. */
export function runDoctor(options: DoctorOptions = {}): DoctorReport {
  const workspace = resolveWorkspace(options.workspace);
  const checks: DoctorCheck[] = [];
  let repaired = 0;

  checks.push(checkNodeVersion());
  checks.push(checkWorkspaceAccess(workspace.rootDir));
  checks.push(checkSafeNode('.mythos directory', join(workspace.rootDir, '.mythos'), true));

  const policy = loadProjectPolicy(workspace.rootDir);
  checks.push(policy.errors.length > 0
    ? fail('project-policy', 'Project policy', policy.errors.join('; '))
    : pass(
      'project-policy',
      'Project policy',
      policy.found ? `Valid policy: ${policy.path}` : 'No project policy found; built-in defaults apply.',
    ));

  const transactionResult = checkTransactions(workspace.rootDir, options.repair === true);
  checks.push(transactionResult.check);
  repaired += transactionResult.repaired;

  const receiptsDir = getReceiptsDir(workspace.rootDir);
  checks.push(checkSafeNode('Receipt directory', receiptsDir, true, 'receipt-store-path'));
  const receiptLock = join(receiptsDir, RECEIPT_STORE_LOCK_FILE);
  if (existsSync(receiptLock)) {
    checks.push(checkSafeNode('Receipt writer lock', receiptLock, false, 'receipt-lock'));
    checks.push(warn(
      'receipt-lock-present',
      'Receipt writer lock state',
      'A receipt writer lock is present. It may be active or will be recovered by the next writer if stale.',
    ));
  } else {
    checks.push(pass('receipt-lock-present', 'Receipt writer lock state', 'No receipt writer lock is present.'));
  }

  try {
    const chain = verifyReceiptChain(receiptsDir);
    checks.push(!chain.present
      ? pass('receipt-chain', 'Receipt chain', 'No chained receipts exist yet.')
      : chain.ok
        ? pass('receipt-chain', 'Receipt chain', `Valid local chain with ${chain.length} receipt(s).`)
        : fail('receipt-chain', 'Receipt chain', chain.reason ?? `Chain is broken at sequence ${chain.brokenAt ?? 0}.`));
  } catch (error) {
    checks.push(fail('receipt-chain', 'Receipt chain', errorMessage(error)));
  }

  const sessionPaths = getSessionPaths(workspace);
  checks.push(checkStructuredFile(
    'session',
    'Scoped session',
    sessionPaths.file,
    raw => parseSessionData(raw) !== null,
    'Session file is valid.',
    'No scoped session exists yet.',
  ));

  checks.push(checkOptionalRegularFile('memory-authority', 'Memory authority', getMemoryPath(workspace)));
  checks.push(checkOptionalRegularFile('memory-index', 'Memory database', getDbPath(workspace)));

  try {
    const telemetry = TelemetryStore.getInstance(workspace);
    const health = telemetry.healthCheck();
    checks.push(health.ok
      ? pass('telemetry', 'Provider telemetry', `SQLite telemetry is healthy: ${telemetry.path}`)
      : fail('telemetry', 'Provider telemetry', health.error ?? 'SQLite quick check failed.'));
  } catch (error) {
    checks.push(fail('telemetry', 'Provider telemetry', errorMessage(error)));
  }

  const failed = checks.filter(check => check.status === 'fail').length;
  return {
    tool: 'mythos-doctor',
    generatedAt: new Date().toISOString(),
    workspace: workspace.rootDir,
    projectId: workspace.projectId,
    repairRequested: options.repair === true,
    repaired,
    ok: failed === 0,
    exitCode: failed === 0 ? 0 : 1,
    checks,
  };
}

function checkNodeVersion(): DoctorCheck {
  const [major = 0, minor = 0] = process.versions.node.split('.').map((part) => Number.parseInt(part, 10));
  return major > 22 || (major === 22 && minor >= 12)
    ? pass('node-version', 'Node.js version', `${process.versions.node} satisfies the Node.js 22.12+ requirement.`)
    : fail('node-version', 'Node.js version', `${process.versions.node} is unsupported; Node.js 22.12+ is required.`);
}

function checkWorkspaceAccess(rootDir: string): DoctorCheck {
  try {
    accessSync(rootDir, constants.R_OK | constants.W_OK);
    return pass('workspace-access', 'Workspace access', `Readable and writable: ${rootDir}`);
  } catch (error) {
    return fail('workspace-access', 'Workspace access', errorMessage(error));
  }
}

function checkTransactions(rootDir: string, repairRequested: boolean): { check: DoctorCheck; repaired: number } {
  let inspections = inspectTransactionJournals(rootDir);
  let repaired = 0;
  const repairErrors: string[] = [];

  if (repairRequested) {
    const recoverable = inspections.filter(item => !item.active && item.state !== 'invalid');
    for (const item of recoverable) {
      const [result] = recoverInterruptedTransactions(rootDir, item.id);
      if (result?.recovered || result?.cleaned) repaired += 1;
      if (result && result.errors.length > 0) repairErrors.push(`${result.id}: ${result.errors.join('; ')}`);
    }
    inspections = inspectTransactionJournals(rootDir);
  }

  if (repairErrors.length > 0) {
    return { check: fail('transactions', 'SWD transaction recovery', repairErrors.join(' | ')), repaired };
  }
  if (inspections.length === 0) {
    return {
      check: {
        ...pass('transactions', 'SWD transaction recovery', 'No unfinished transaction journals found.'),
        repaired: repaired > 0,
      },
      repaired,
    };
  }

  const invalid = inspections.filter(item => item.state === 'invalid');
  const interrupted = inspections.filter(item => !item.active && !isTerminal(item));
  const active = inspections.filter(item => item.active && !isTerminal(item));
  const terminalResidue = inspections.filter(isTerminal);

  if (invalid.length > 0 || interrupted.length > 0) {
    const parts = [
      invalid.length > 0 ? `${invalid.length} invalid journal(s)` : '',
      interrupted.length > 0 ? `${interrupted.length} interrupted transaction(s) require recovery` : '',
      active.length > 0 ? `${active.length} active transaction(s)` : '',
    ].filter(Boolean);
    return { check: fail('transactions', 'SWD transaction recovery', parts.join('; ')), repaired };
  }

  return {
    check: warn(
      'transactions',
      'SWD transaction recovery',
      [
        active.length > 0 ? `${active.length} transaction(s) are owned by a live process.` : '',
        terminalResidue.length > 0 ? `${terminalResidue.length} terminal journal(s) remain as removable residue.` : '',
      ].filter(Boolean).join(' '),
    ),
    repaired,
  };
}

function isTerminal(item: TransactionInspection): boolean {
  return item.state === 'committed' || item.state === 'rolled-back';
}

function checkSafeNode(
  label: string,
  path: string,
  expectDirectory: boolean,
  id = 'mythos-path',
): DoctorCheck {
  if (!existsSync(path)) return pass(id, label, `Not present: ${path}`);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return fail(id, label, `Unsafe symbolic link: ${path}`);
    if (expectDirectory ? !stat.isDirectory() : !stat.isFile()) {
      return fail(id, label, `Unexpected filesystem node type: ${path}`);
    }
    return pass(id, label, `Safe ${expectDirectory ? 'directory' : 'regular file'}: ${path}`);
  } catch (error) {
    return fail(id, label, errorMessage(error));
  }
}

function checkStructuredFile(
  id: string,
  label: string,
  path: string,
  validate: (raw: string) => boolean,
  validDetail: string,
  missingDetail: string,
): DoctorCheck {
  if (!existsSync(path)) return pass(id, label, missingDetail);
  const safe = checkSafeNode(label, path, false, id);
  if (safe.status === 'fail') return safe;
  try {
    return validate(readFileSync(path, 'utf8'))
      ? pass(id, label, validDetail)
      : fail(id, label, `File is malformed or unsupported: ${path}`);
  } catch (error) {
    return fail(id, label, errorMessage(error));
  }
}

function checkOptionalRegularFile(id: string, label: string, path: string): DoctorCheck {
  if (!existsSync(path)) return pass(id, label, `Not initialized: ${path}`);
  return checkSafeNode(label, path, false, id);
}

function pass(id: string, label: string, detail: string): DoctorCheck {
  return { id, label, status: 'pass', detail };
}

function warn(id: string, label: string, detail: string): DoctorCheck {
  return { id, label, status: 'warn', detail };
}

function fail(id: string, label: string, detail: string): DoctorCheck {
  return { id, label, status: 'fail', detail };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
