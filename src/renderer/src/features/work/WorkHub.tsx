// Plane, Notion and Google Calendar inside the Tasks tab (custom fork).
import type { WorkItem, WorkSource } from "@openbot/contracts/ipc";
import {
  Bot,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  Clock3,
  ExternalLink,
  Hourglass,
  Inbox,
  ListChecks,
  Plug,
  Plus,
  RefreshCw,
  Search,
} from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { BarList, Card, ColumnChart, DonutChart, STATUS_COLORS, StatCard } from "./work-charts";
import {
  dayKey,
  dueState,
  eventDayKey,
  formatDue,
  formatEventTime,
  isOpen,
  itemAgentBrief,
  STATUS_GROUP_LABEL,
  todayKey,
  workStore,
} from "./work-store";
import "./work.css";

type HubTab = "summary" | "plane" | "notion" | "calendar";
type ListFilter = "open" | "late" | "week" | "done" | "all";

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  urgente: 0,
  high: 1,
  alta: 1,
  medium: 2,
  média: 2,
  media: 2,
  low: 3,
  baixa: 3,
};

function sortItems(items: readonly WorkItem[]): WorkItem[] {
  return [...items].sort((left, right) => {
    const leftDue = left.due ?? "9999";
    const rightDue = right.due ?? "9999";
    if (leftDue !== rightDue) return leftDue.localeCompare(rightDue);
    const leftPriority = PRIORITY_ORDER[(left.priority ?? "").toLowerCase()] ?? 9;
    const rightPriority = PRIORITY_ORDER[(right.priority ?? "").toLowerCase()] ?? 9;
    return leftPriority - rightPriority;
  });
}

export function WorkSetup() {
  const status = () => workStore.snapshot()?.status;
  const importable = () => status()?.importable ?? [];
  const google = () => status()?.google;
  return (
    <div class="work-setup">
      <Show when={importable().length > 0}>
        <div class="work-setup-row">
          <Plug class="size-4" aria-hidden="true" />
          <span>
            Encontrei configurações locais de {importable().join(", ")} (NotchMestre / busca-vagas). As chaves vão para
            o cofre criptografado do OpenBot.
          </span>
          <button
            type="button"
            class="work-button"
            data-primary=""
            disabled={workStore.busy()}
            onClick={() => void workStore.importLocal()}
          >
            Importar configurações
          </button>
        </div>
      </Show>
      <Show when={google()?.canConnect && !google()?.connected}>
        <div class="work-setup-row">
          <CalendarClock class="size-4" aria-hidden="true" />
          <span>
            Ligue o Google Agenda com o app Google do busca-vagas. Abre o navegador para você autorizar uma vez.
          </span>
          <button
            type="button"
            class="work-button"
            data-primary=""
            disabled={workStore.busy()}
            onClick={() => void workStore.connectGoogle()}
          >
            Conectar Google Agenda
          </button>
        </div>
      </Show>
    </div>
  );
}

export function WorkErrors() {
  const errors = () => workStore.snapshot()?.errors ?? [];
  return (
    <>
      <Show when={workStore.error()}>
        {(error) => (
          <div class="work-alert" role="alert">
            <CircleAlert class="size-4" aria-hidden="true" />
            <span>{error()}</span>
            <button type="button" class="work-link" onClick={workStore.dismissError}>
              Fechar
            </button>
          </div>
        )}
      </Show>
      <For each={errors()}>
        {(error) => (
          <div class="work-alert" data-soft="">
            <CircleAlert class="size-4" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
      </For>
    </>
  );
}

function StatusSelect(props: { item: WorkItem }) {
  return (
    <span class="work-status" style={{ "--work-status-color": STATUS_COLORS[props.item.statusGroup] }}>
      <span class="work-status-dot" aria-hidden="true" />
      <select
        aria-label={`Status de ${props.item.title}`}
        value={props.item.statusId ?? ""}
        disabled={props.item.statusOptions.length === 0}
        onChange={(event) => void workStore.setStatus(props.item, event.currentTarget.value)}
      >
        <Show when={!props.item.statusId}>
          <option value="">{props.item.status}</option>
        </Show>
        <For each={props.item.statusOptions}>{(option) => <option value={option.id}>{option.name}</option>}</For>
      </select>
    </span>
  );
}

export function WorkItemRow(props: { item: WorkItem; onSendToAgent?: (text: string) => void; compact?: boolean }) {
  const due = () => dueState(props.item);
  return (
    <li class="work-row" data-group={props.item.statusGroup}>
      <StatusSelect item={props.item} />
      <button
        type="button"
        class="work-row-main"
        onClick={() => workStore.openUrl(props.item.url)}
        title="Abrir no navegador"
      >
        <span class="work-row-title">
          <Show when={props.item.ref}>
            <span class="work-row-ref">{props.item.ref}</span>
          </Show>
          {props.item.title}
        </span>
        <Show when={!props.compact}>
          <span class="work-row-meta">
            {props.item.workspace} · {props.item.container}
          </span>
        </Show>
      </button>
      <Show when={props.item.priority}>
        <span class="work-pill" data-priority={(props.item.priority ?? "").toLowerCase()}>
          {props.item.priority}
        </span>
      </Show>
      <Show when={props.item.due}>
        <span class="work-pill" data-due={due()}>
          {formatDue(props.item.due)}
        </span>
      </Show>
      <Show when={props.onSendToAgent}>
        {(send) => (
          <button
            type="button"
            class="work-icon-button"
            title="Mandar para um agente"
            aria-label={`Mandar ${props.item.title} para um agente`}
            onClick={() => send()(itemAgentBrief(props.item))}
          >
            <Bot class="size-4" aria-hidden="true" />
          </button>
        )}
      </Show>
      <button
        type="button"
        class="work-icon-button"
        title="Abrir"
        aria-label={`Abrir ${props.item.title}`}
        onClick={() => workStore.openUrl(props.item.url)}
      >
        <ExternalLink class="size-4" aria-hidden="true" />
      </button>
    </li>
  );
}

function WorkList(props: { source: WorkSource; onSendToAgent?: (text: string) => void }) {
  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal<ListFilter>("open");
  const [workspace, setWorkspace] = createSignal("");
  const items = createMemo(() => (workStore.snapshot()?.items ?? []).filter((item) => item.source === props.source));
  const workspaces = createMemo(() => [...new Set(items().map((item) => item.workspace))].sort());
  const shown = createMemo(() => {
    const text = query().trim().toLowerCase();
    return sortItems(
      items().filter((item) => {
        if (workspace() && item.workspace !== workspace()) return false;
        const state = dueState(item);
        const open = isOpen(item);
        if (filter() === "open" && !open) return false;
        if (filter() === "late" && !(open && state === "overdue")) return false;
        if (filter() === "week" && !(open && (state === "today" || state === "week" || state === "overdue")))
          return false;
        if (filter() === "done" && open) return false;
        if (!text) return true;
        return `${item.ref ?? ""} ${item.title} ${item.container} ${item.workspace}`.toLowerCase().includes(text);
      }),
    );
  });
  const filters: { id: ListFilter; label: string }[] = [
    { id: "open", label: "Abertas" },
    { id: "late", label: "Atrasadas" },
    { id: "week", label: "Esta semana" },
    { id: "done", label: "Concluídas" },
    { id: "all", label: "Todas" },
  ];
  return (
    <div class="work-list">
      <div class="work-toolbar">
        <label class="work-search">
          <Search class="size-4" aria-hidden="true" />
          <input
            type="search"
            placeholder={props.source === "plane" ? "Buscar no Plane" : "Buscar no Notion"}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <div class="work-chips" role="group" aria-label="Filtro">
          <For each={filters}>
            {(option) => (
              <button
                type="button"
                class="work-chip"
                aria-pressed={filter() === option.id ? "true" : "false"}
                onClick={() => setFilter(option.id)}
              >
                {option.label}
              </button>
            )}
          </For>
        </div>
        <Show when={workspaces().length > 1}>
          <select class="work-select" value={workspace()} onChange={(event) => setWorkspace(event.currentTarget.value)}>
            <option value="">Todos os espaços</option>
            <For each={workspaces()}>{(name) => <option value={name}>{name}</option>}</For>
          </select>
        </Show>
      </div>
      <Show
        when={shown().length > 0}
        fallback={
          <p class="work-empty">{items().length === 0 ? "Nada carregado ainda." : "Nenhuma tarefa neste filtro."}</p>
        }
      >
        <p class="work-count">{shown().length} tarefas</p>
        <ul class="work-rows">
          <For each={shown().slice(0, 300)}>
            {(item) => <WorkItemRow item={item} onSendToAgent={props.onSendToAgent} />}
          </For>
        </ul>
      </Show>
    </div>
  );
}

export function NewEventForm() {
  const [title, setTitle] = createSignal("");
  const [when, setWhen] = createSignal("");
  const [minutes, setMinutes] = createSignal(30);
  const [saved, setSaved] = createSignal<string | null>(null);
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const start = new Date(when());
    if (!title().trim() || Number.isNaN(start.getTime())) return;
    const created = await workStore.createEvent(title().trim(), start, minutes());
    if (created) {
      setSaved(`Criado: ${created.title}`);
      setTitle("");
    }
  };
  return (
    <form class="work-event-form" onSubmit={(event) => void save(event)}>
      <input
        class="work-input"
        placeholder="Novo compromisso"
        value={title()}
        onInput={(event) => setTitle(event.currentTarget.value)}
      />
      <input
        class="work-input"
        type="datetime-local"
        value={when()}
        onInput={(event) => setWhen(event.currentTarget.value)}
        aria-label="Início"
      />
      <select
        class="work-select"
        value={String(minutes())}
        onChange={(event) => setMinutes(Number(event.currentTarget.value))}
      >
        <option value="15">15 min</option>
        <option value="30">30 min</option>
        <option value="60">1 h</option>
        <option value="90">1 h 30</option>
        <option value="120">2 h</option>
      </select>
      <button type="submit" class="work-button" data-primary="" disabled={!title().trim() || !when()}>
        <Plus class="size-4" aria-hidden="true" />
        Criar
      </button>
      <Show when={saved()}>
        <span class="work-saved">{saved()}</span>
      </Show>
    </form>
  );
}

export function AgendaList(props: { days?: number; limit?: number }) {
  const groups = createMemo(() => {
    const events = workStore.snapshot()?.events ?? [];
    const end = new Date();
    end.setDate(end.getDate() + (props.days ?? 14));
    const last = dayKey(end);
    const byDay = new Map<string, typeof events>();
    for (const event of events) {
      const key = eventDayKey(event);
      if (key < todayKey() || key > last) continue;
      byDay.set(key, [...(byDay.get(key) ?? []), event]);
    }
    return [...byDay.entries()].sort(([left], [right]) => left.localeCompare(right));
  });
  const google = () => workStore.snapshot()?.status.google;
  return (
    <Show
      when={google()?.connected}
      fallback={<p class="work-empty">Google Agenda não conectado. Use “Conectar Google Agenda”.</p>}
    >
      <Show when={groups().length > 0} fallback={<p class="work-empty">Nenhum compromisso nos próximos dias.</p>}>
        <div class="work-agenda">
          <For each={groups().slice(0, props.limit ?? 14)}>
            {([day, events]) => (
              <div class="work-agenda-day">
                <h4>{formatDue(day)}</h4>
                <ul>
                  <For each={events}>
                    {(event) => (
                      <li>
                        <span class="work-agenda-time">{formatEventTime(event)}</span>
                        <button
                          type="button"
                          class="work-agenda-title"
                          onClick={() => event.url && workStore.openUrl(event.url)}
                        >
                          {event.title}
                        </button>
                        <span class="work-agenda-calendar">{event.calendar}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            )}
          </For>
        </div>
      </Show>
    </Show>
  );
}

export function useWorkMetrics() {
  return createMemo(() => {
    const items = workStore.snapshot()?.items ?? [];
    const open = items.filter(isOpen);
    const overdue = open.filter((item) => dueState(item) === "overdue");
    const today = open.filter((item) => dueState(item) === "today");
    const week = open.filter((item) => dueState(item) === "week");
    const done = items.filter((item) => item.statusGroup === "done");
    const groups = (["backlog", "todo", "doing", "done"] as const).map((group) => ({
      label: STATUS_GROUP_LABEL[group],
      value: items.filter((item) => item.statusGroup === group).length,
      color: STATUS_COLORS[group],
    }));
    const containers = new Map<string, number>();
    for (const item of open) {
      const key = `${item.source === "plane" ? "Plane" : "Notion"} · ${item.container}`;
      containers.set(key, (containers.get(key) ?? 0) + 1);
    }
    const byContainer = [...containers.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8)
      .map(([label, value]) => ({ label, value }));
    const days: { label: string; key: string }[] = [];
    for (let offset = 6; offset >= 0; offset--) {
      const date = new Date();
      date.setDate(date.getDate() - offset);
      days.push({ key: dayKey(date), label: date.toLocaleDateString("pt-BR", { weekday: "narrow" }) });
    }
    const doneByDay = days.map((day) => ({
      label: day.label,
      value: done.filter((item) => item.updatedAt && dayKey(new Date(item.updatedAt)) === day.key).length,
      highlight: day.key === todayKey(),
    }));
    const nextDays: { label: string; key: string }[] = [];
    for (let offset = 0; offset < 7; offset++) {
      const date = new Date();
      date.setDate(date.getDate() + offset);
      nextDays.push({ key: dayKey(date), label: date.toLocaleDateString("pt-BR", { weekday: "narrow" }) });
    }
    const dueByDay = nextDays.map((day, index) => ({
      label: day.label,
      value: open.filter((item) => item.due === day.key).length + (index === 0 ? overdue.length : 0),
      highlight: index === 0,
    }));
    const doneWeek = doneByDay.reduce((sum, day) => sum + day.value, 0);
    const completion = open.length + doneWeek > 0 ? doneWeek / (open.length + doneWeek) : 0;
    return { items, open, overdue, today, week, done, groups, byContainer, doneByDay, dueByDay, doneWeek, completion };
  });
}

function WorkSummary(props: { onTab: (tab: HubTab) => void }) {
  const metrics = useWorkMetrics();
  return (
    <div class="work-summary">
      <div class="work-stats">
        <StatCard
          icon={<ListChecks class="size-4" />}
          label="Abertas"
          value={metrics().open.length}
          tone="accent"
          onClick={() => props.onTab("plane")}
        />
        <StatCard
          icon={<CircleAlert class="size-4" />}
          label="Atrasadas"
          value={metrics().overdue.length}
          tone="danger"
        />
        <StatCard icon={<Clock3 class="size-4" />} label="Vencem hoje" value={metrics().today.length} tone="warning" />
        <StatCard icon={<Hourglass class="size-4" />} label="Próximos 7 dias" value={metrics().week.length} />
        <StatCard
          icon={<CircleCheck class="size-4" />}
          label="Concluídas (7 dias)"
          value={metrics().doneWeek}
          tone="success"
        />
      </div>
      <div class="work-grid">
        <Card title="Por status">
          <DonutChart slices={metrics().groups} label="tarefas" />
        </Card>
        <Card title="Abertas por projeto">
          <BarList rows={metrics().byContainer} />
        </Card>
        <Card title="Concluídas por dia">
          <ColumnChart columns={metrics().doneByDay} />
        </Card>
        <Card title="Prazos da semana">
          <ColumnChart columns={metrics().dueByDay} />
        </Card>
      </div>
    </div>
  );
}

export function WorkHub(props: { onSendToAgent?: (text: string) => void }) {
  const detach = workStore.attach();
  onCleanup(detach);
  const [tab, setTab] = createSignal<HubTab>("summary");
  const status = () => workStore.snapshot()?.status;
  const count = (source: WorkSource) =>
    (workStore.snapshot()?.items ?? []).filter((item) => item.source === source && isOpen(item)).length;
  const tabs = (): { id: HubTab; label: string; badge?: number; icon: JSX.Element }[] => [
    { id: "summary", label: "Resumo", icon: <Inbox class="size-4" /> },
    { id: "plane", label: "Plane", badge: count("plane"), icon: <ListChecks class="size-4" /> },
    { id: "notion", label: "Notion", badge: count("notion"), icon: <ListChecks class="size-4" /> },
    { id: "calendar", label: "Agenda", icon: <CalendarClock class="size-4" /> },
  ];
  const updated = () => {
    const at = workStore.snapshot()?.fetchedAt;
    return at ? new Date(at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : null;
  };
  return (
    <section class="work-hub" aria-label="Plane, Notion e Agenda">
      <div class="work-hub-head">
        <div class="work-tabs" role="tablist">
          <For each={tabs()}>
            {(item) => (
              <button
                type="button"
                role="tab"
                class="work-tab"
                aria-selected={tab() === item.id ? "true" : "false"}
                onClick={() => setTab(item.id)}
              >
                {item.icon}
                {item.label}
                <Show when={item.badge}>
                  <span class="work-tab-badge">{item.badge}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
        <div class="work-hub-actions">
          <Show when={updated()}>
            <span class="work-updated">Atualizado {updated()}</span>
          </Show>
          <button
            type="button"
            class="work-icon-button"
            title="Atualizar agora"
            aria-label="Atualizar agora"
            data-spinning={workStore.busy() ? "" : undefined}
            onClick={() => void workStore.refresh(true)}
          >
            <RefreshCw class="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      <WorkSetup />
      <WorkErrors />
      <Show when={tab() === "summary"}>
        <WorkSummary onTab={setTab} />
      </Show>
      <Show when={tab() === "plane"}>
        <Show when={status()?.plane.connected} fallback={<p class="work-empty">Plane não conectado.</p>}>
          <WorkList source="plane" onSendToAgent={props.onSendToAgent} />
        </Show>
      </Show>
      <Show when={tab() === "notion"}>
        <Show when={status()?.notion.connected} fallback={<p class="work-empty">Notion não conectado.</p>}>
          <WorkList source="notion" onSendToAgent={props.onSendToAgent} />
        </Show>
      </Show>
      <Show when={tab() === "calendar"}>
        <Show when={status()?.google.connected}>
          <NewEventForm />
        </Show>
        <AgendaList />
      </Show>
    </section>
  );
}
