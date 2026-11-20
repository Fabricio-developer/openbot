// One shared copy of the work integrations data (Plane, Notion, Google Calendar) for the Tasks tab and the Dashboard.
import type {
  WorkCalendarEvent,
  WorkDisconnectInput,
  WorkIntegrationsStatus,
  WorkItem,
  WorkSnapshot,
} from "@openbot/contracts/ipc";
import { createSignal } from "solid-js";

const REFRESH_MS = 5 * 60_000;
/** While the main process renews an old copy in the background, ask again after this long. */
const FOLLOW_UP_MS = 45_000;

const [snapshot, setSnapshot] = createSignal<WorkSnapshot | null>(null);
const [busy, setBusy] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;
let followUp: ReturnType<typeof setTimeout> | undefined;
let users = 0;

function api() {
  return window.openbot.workIntegrations;
}

function message(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

async function refresh(force = false): Promise<void> {
  setBusy(true);
  try {
    const next = await api().refresh(force ? { force: true } : undefined);
    setSnapshot(next);
    setError(null);
    const old = next.fetchedAt === null || Date.now() - Date.parse(next.fetchedAt) > REFRESH_MS;
    clearTimeout(followUp);
    if (!force && old) followUp = setTimeout(() => void refresh(), FOLLOW_UP_MS);
  } catch (cause) {
    setError(message(cause));
  } finally {
    setBusy(false);
  }
}

async function withStatus(run: () => Promise<WorkIntegrationsStatus>): Promise<void> {
  setBusy(true);
  try {
    const status = await run();
    setSnapshot((current) =>
      current ? { ...current, status } : { status, items: [], events: [], fetchedAt: null, errors: [] },
    );
    setError(null);
    await refresh(true);
  } catch (cause) {
    setError(message(cause));
  } finally {
    setBusy(false);
  }
}

async function setStatus(item: WorkItem, statusId: string): Promise<void> {
  const previous = snapshot();
  const option = item.statusOptions.find((candidate) => candidate.id === statusId);
  if (previous && option)
    setSnapshot({
      ...previous,
      items: previous.items.map((candidate) =>
        candidate.id === item.id
          ? { ...candidate, status: option.name, statusId, statusGroup: option.group }
          : candidate,
      ),
    });
  try {
    const updated = await api().setStatus({ itemId: item.id, statusId });
    setSnapshot((current) =>
      current
        ? { ...current, items: current.items.map((candidate) => (candidate.id === updated.id ? updated : candidate)) }
        : current,
    );
    setError(null);
  } catch (cause) {
    if (previous) setSnapshot(previous);
    setError(message(cause));
  }
}

async function createEvent(title: string, start: Date, minutes: number): Promise<WorkCalendarEvent | null> {
  try {
    const event = await api().createEvent({
      title,
      start: start.toISOString(),
      end: new Date(start.getTime() + minutes * 60_000).toISOString(),
    });
    setSnapshot((current) =>
      current
        ? {
            ...current,
            events: [...current.events, event].sort((left, right) => left.start.localeCompare(right.start)),
          }
        : current,
    );
    setError(null);
    return event;
  } catch (cause) {
    setError(message(cause));
    return null;
  }
}

/** Starts the shared refresh loop while at least one screen uses it; call the returned function on cleanup. */
function attach(): () => void {
  users++;
  if (users === 1) {
    if (!snapshot()) void refresh();
    else void refresh();
    timer = setInterval(() => void refresh(), REFRESH_MS);
  }
  return () => {
    users = Math.max(0, users - 1);
    if (users === 0) {
      clearInterval(timer);
      clearTimeout(followUp);
    }
  };
}

export const workStore = {
  snapshot,
  busy,
  error,
  dismissError: () => setError(null),
  attach,
  refresh,
  setStatus,
  createEvent,
  importLocal: () => withStatus(() => api().importLocal()),
  connectGoogle: () => withStatus(() => api().connectGoogle()),
  disconnect: (source: WorkDisconnectInput) => withStatus(() => api().disconnect(source)),
  openUrl: (url: string) => {
    if (url.startsWith("https://")) void api().openUrl(url);
  },
};

// ---------- derived helpers shared by both screens ----------

export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function todayKey(): string {
  return dayKey(new Date());
}

export function isOpen(item: WorkItem): boolean {
  return item.statusGroup !== "done" && item.statusGroup !== "cancelled";
}

export type DueState = "overdue" | "today" | "week" | "later" | "none";

export function dueState(item: WorkItem): DueState {
  if (!item.due) return "none";
  const today = todayKey();
  if (item.due < today) return "overdue";
  if (item.due === today) return "today";
  const week = new Date();
  week.setDate(week.getDate() + 7);
  return item.due <= dayKey(week) ? "week" : "later";
}

export function formatDue(due: string | null): string {
  if (!due) return "";
  const [year, month, day] = due.split("-").map(Number);
  if (!year || !month || !day) return due;
  const date = new Date(year, month - 1, day);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((date.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return "Hoje";
  if (diff === 1) return "Amanhã";
  if (diff === -1) return "Ontem";
  if (diff < 0) return `${-diff} dias atrás`;
  if (diff < 7) return date.toLocaleDateString("pt-BR", { weekday: "short" });
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

export function formatEventTime(event: WorkCalendarEvent): string {
  if (event.allDay) return "Dia todo";
  const start = new Date(event.start);
  const end = new Date(event.end);
  const time = (date: Date) => date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${time(start)}–${time(end)}`;
}

export function eventDayKey(event: WorkCalendarEvent): string {
  return event.allDay ? event.start.slice(0, 10) : dayKey(new Date(event.start));
}

export const STATUS_GROUP_LABEL = {
  backlog: "Backlog",
  todo: "A fazer",
  doing: "Em andamento",
  done: "Concluído",
  cancelled: "Cancelado",
} as const;

export function itemAgentBrief(item: WorkItem): string {
  const source = item.source === "plane" ? "Plane" : "Notion";
  const head = item.ref ? `${source} ${item.ref}` : `${source} (${item.container})`;
  const lines = [
    `Tarefa do ${head}: ${item.title}`,
    `Projeto: ${item.workspace} / ${item.container}`,
    `Status atual: ${item.status}${item.due ? ` · Prazo: ${item.due}` : ""}${item.priority ? ` · Prioridade: ${item.priority}` : ""}`,
    `Link: ${item.url}`,
  ];
  return lines.join("\n");
}
