import { randomUUID } from "node:crypto";

/**
 * Approvals in the Bluewren app. Changing a ticket or refunding it is never done on a voice "yes"
 * alone: the MCP server asks the client to open this page (URL elicitation), and the traveler
 * approves there, as they would in the airline's app. The demo page shows it in a phone.
 */
export type Outcome = "approved" | "declined" | "expired";

export interface Approval {
  id: string;
  title: string;
  lines: string[];
  outcome?: Outcome;
  done: Promise<Outcome>;
  resolve: (o: Outcome) => void;
}

const pending = new Map<string, Approval>();
const TIMEOUT_MS = Number(process.env.BW_APPROVAL_TIMEOUT_MS ?? 180_000);

export function requestApproval(title: string, lines: string[]): Approval {
  let resolve!: (o: Outcome) => void;
  const done = new Promise<Outcome>((r) => (resolve = r));
  const a: Approval = { id: randomUUID(), title, lines, done, resolve };
  pending.set(a.id, a);
  const timer = setTimeout(() => settle(a.id, "expired"), TIMEOUT_MS);
  void done.then(() => clearTimeout(timer));
  return a;
}

export function getApproval(id: string): Approval | undefined {
  return pending.get(id);
}

export function settle(id: string, outcome: Outcome): boolean {
  const a = pending.get(id);
  if (!a || a.outcome) return false;
  a.outcome = outcome;
  a.resolve(outcome);
  setTimeout(() => pending.delete(id), 10 * 60_000);
  return true;
}
