// Work integrations (custom fork): tasks from Plane and Notion and events from Google Calendar, read by the desktop
// main process with credentials kept in OpenBot's encrypted secret storage.

export type WorkSource = "plane" | "notion";
export type WorkStatusGroup = "backlog" | "todo" | "doing" | "done" | "cancelled";

export interface WorkStatusOption {
  id: string;
  name: string;
  group: WorkStatusGroup;
  color: string | null;
}

export interface WorkItem {
  /** Stable id: `plane:<workspace>:<project>:<issue>` or `notion:<database>:<page>`. */
  id: string;
  source: WorkSource;
  title: string;
  url: string;
  /** Plane workspace slug or Notion workspace name. */
  workspace: string;
  /** Plane project name or Notion database name. */
  container: string;
  /** Short reference such as `SO-123`, when the source has one. */
  ref: string | null;
  status: string;
  statusId: string | null;
  statusGroup: WorkStatusGroup;
  statusOptions: WorkStatusOption[];
  priority: string | null;
  due: string | null;
  updatedAt: string | null;
}

export interface WorkCalendarEvent {
  id: string;
  calendar: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  url: string | null;
  location: string | null;
}

export interface WorkSourceStatus {
  connected: boolean;
  /** Plane workspaces, Notion databases or Google account shown to the user. */
  detail: string[];
  error: string | null;
}

export interface WorkIntegrationsStatus {
  plane: WorkSourceStatus;
  notion: WorkSourceStatus;
  google: WorkSourceStatus & { canConnect: boolean };
  /** Local setups found on this computer that `importLocal` can copy (NotchMestre, busca-vagas). */
  importable: string[];
}

export interface WorkSnapshot {
  status: WorkIntegrationsStatus;
  items: WorkItem[];
  events: WorkCalendarEvent[];
  fetchedAt: string | null;
  errors: string[];
}

export interface WorkRefreshInput {
  force?: boolean;
}

export interface WorkSetStatusInput {
  itemId: string;
  statusId: string;
}

export interface WorkCreateEventInput {
  title: string;
  start: string;
  end: string;
}

export type WorkDisconnectInput = "plane" | "notion" | "google";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid ${what}.`);
  return value;
}

export function decodeWorkIntegrationsStatus(value: unknown): WorkIntegrationsStatus {
  const record = requireRecord(value, "work integrations status");
  for (const key of ["plane", "notion", "google"]) requireRecord(record[key], `${key} status`);
  if (!Array.isArray(record.importable)) throw new Error("Invalid importable list.");
  return record as unknown as WorkIntegrationsStatus;
}

export function decodeWorkSnapshot(value: unknown): WorkSnapshot {
  const record = requireRecord(value, "work snapshot");
  decodeWorkIntegrationsStatus(record.status);
  if (!Array.isArray(record.items) || !Array.isArray(record.events) || !Array.isArray(record.errors))
    throw new Error("Invalid work snapshot.");
  return record as unknown as WorkSnapshot;
}

export function decodeWorkItem(value: unknown): WorkItem {
  const record = requireRecord(value, "work item");
  if (typeof record.id !== "string" || typeof record.title !== "string") throw new Error("Invalid work item.");
  return record as unknown as WorkItem;
}

export function decodeWorkCalendarEvent(value: unknown): WorkCalendarEvent {
  const record = requireRecord(value, "calendar event");
  if (typeof record.id !== "string" || typeof record.start !== "string") throw new Error("Invalid calendar event.");
  return record as unknown as WorkCalendarEvent;
}
