// Dashboard (custom fork): one control-center page with agents, usage, tasks, deadlines, agenda, routines and CRM.
// Layout follows the dark "bento" dashboards collected from Pinterest: a row of number cards, then a card grid.
import type { Routine } from "@openbot/contracts/ipc";
import {
  Bot,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  Clock3,
  Gauge as GaugeIcon,
  ListChecks,
  RefreshCw,
  UsersRound,
  Workflow,
} from "@openbot/ui";
import { PageHeader } from "@openbot/ui/features/window/PageHeader";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { useTurns } from "../../turns";
import { useAgents } from "../agents/agents-context";
import { desktopCrmHost } from "../crm/crm-port";
import { usePlanLimitRows } from "../usage/plan-limit-rows";
import { useUsage } from "../usage/usage-context";
import { AgendaList, NewEventForm, useWorkMetrics, WorkErrors, WorkItemRow, WorkSetup } from "./WorkHub";
import { BarList, Card, ColumnChart, DonutChart, Gauge, StatCard } from "./work-charts";
import { dueState, eventDayKey, isOpen, todayKey, workStore } from "./work-store";
import "./work.css";

type AgentState = "working" | "failed" | "limited" | "idle";

const AGENT_STATE_LABEL: Record<AgentState, string> = {
  working: "Trabalhando",
  failed: "Com erro",
  limited: "No limite",
  idle: "Parado",
};

export function DashboardPage(props: { serverId: string; hostName: string; onBack?: () => void }) {
  const detach = workStore.attach();
  onCleanup(detach);
  const { agentList } = useAgents();
  const { activeTurns, failedTurns, usageLimits } = useTurns();
  const usageRows = usePlanLimitRows();
  const usage = useUsage();
  const metrics = useWorkMetrics();
  const [routines, setRoutines] = createSignal<Routine[]>([]);
  const [crm, setCrm] = createSignal<{ customers: string; proposals: number; sources: number } | null>(null);

  const loadExtras = () => {
    const agents = agentList();
    void Promise.all(agents.map((agent) => window.openbot.agent.listRoutines(agent.id, props.serverId).catch(() => [])))
      .then((lists) => setRoutines(lists.flat()))
      .catch(() => setRoutines([]));
    const host = desktopCrmHost(props.serverId);
    void Promise.all([host.overview(), host.customers()])
      .then(([overview, page]) =>
        setCrm({
          customers: `${page.customers.length}${page.next !== null ? "+" : ""}`,
          proposals: overview.proposals.length,
          sources: overview.sources.length,
        }),
      )
      .catch(() => setCrm(null));
  };
  loadExtras();
  const extrasTimer = setInterval(loadExtras, 5 * 60_000);
  onCleanup(() => clearInterval(extrasTimer));

  const agentStates = createMemo(() => {
    const active = activeTurns();
    const failed = failedTurns();
    const limited = usageLimits();
    return agentList().map((agent) => {
      const state: AgentState = active[agent.id]
        ? "working"
        : failed[agent.id]
          ? "failed"
          : agent.id in limited
            ? "limited"
            : "idle";
      return { agent, state };
    });
  });
  const stateCount = (state: AgentState) => agentStates().filter((entry) => entry.state === state).length;
  const agentsShown = createMemo(() => {
    const order: Record<AgentState, number> = { working: 0, failed: 1, limited: 2, idle: 3 };
    return [...agentStates()].sort((left, right) => order[left.state] - order[right.state]).slice(0, 10);
  });

  const usageBars = createMemo(() =>
    usageRows()
      .filter((row) => row.reportsUsage && row.windows.length > 0)
      .flatMap((row) =>
        row.windows.slice(0, 2).map((window) => ({
          label: `${row.name} · ${window.label}`,
          value: Math.round(100 - window.remainingPercent),
          max: 100,
          hint: `${Math.round(100 - window.remainingPercent)}%${window.resetsAtLabel ? ` · ${window.resetsAtLabel}` : ""}`,
          color:
            window.tone === "critical"
              ? "var(--openbot-danger)"
              : window.tone === "warning"
                ? "var(--openbot-warning)"
                : undefined,
        })),
      )
      .slice(0, 8),
  );
  const highestUsage = createMemo(() => Math.max(0, ...usageBars().map((bar) => bar.value)));

  const todayEvents = createMemo(() =>
    (workStore.snapshot()?.events ?? []).filter((event) => eventDayKey(event) === todayKey()),
  );
  const focus = createMemo(() =>
    metrics()
      .open.filter((item) => {
        const state = dueState(item);
        return state === "overdue" || state === "today";
      })
      .sort((left, right) => (left.due ?? "").localeCompare(right.due ?? ""))
      .slice(0, 8),
  );
  const activeRoutines = createMemo(() => routines().filter((routine) => routine.active));
  const routinesByAgent = createMemo(() => {
    const names = new Map(agentList().map((agent) => [agent.id, agent.name]));
    const counts = new Map<string, number>();
    for (const routine of activeRoutines()) counts.set(routine.agentId, (counts.get(routine.agentId) ?? 0) + 1);
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 6)
      .map(([agentId, value]) => ({ label: names.get(agentId) ?? "Agente", value }));
  });
  const greeting = () => {
    const hour = new Date().getHours();
    return hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
  };
  const today = () => new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });

  return (
    <section class="dashboard-page" aria-label="Dashboard">
      <div class="dashboard-scroll">
        <div class="dashboard-column">
          <PageHeader title="Dashboard" hostName={props.hostName} onBack={props.onBack} class="dashboard-header">
            <button
              type="button"
              class="work-icon-button"
              title="Atualizar tudo"
              aria-label="Atualizar tudo"
              data-spinning={workStore.busy() ? "" : undefined}
              onClick={() => {
                void workStore.refresh(true);
                loadExtras();
              }}
            >
              <RefreshCw class="size-4" aria-hidden="true" />
            </button>
          </PageHeader>
          <p class="dashboard-greeting">
            {greeting()}! <span>{today()}</span>
          </p>
          <WorkSetup />
          <WorkErrors />

          <div class="work-stats dashboard-stats">
            <StatCard
              icon={<Bot class="size-4" />}
              label="Agentes trabalhando"
              value={`${stateCount("working")}/${agentList().length}`}
              hint={stateCount("failed") > 0 ? `${stateCount("failed")} com erro` : undefined}
              tone="accent"
            />
            <StatCard
              icon={<ListChecks class="size-4" />}
              label="Tarefas abertas"
              value={metrics().open.length}
              hint="Plane + Notion"
              onClick={() => usage.openTasks(props.serverId, null)}
            />
            <StatCard
              icon={<CircleAlert class="size-4" />}
              label="Atrasadas"
              value={metrics().overdue.length}
              tone="danger"
            />
            <StatCard
              icon={<Clock3 class="size-4" />}
              label="Vencem hoje"
              value={metrics().today.length}
              tone="warning"
            />
            <StatCard
              icon={<CalendarClock class="size-4" />}
              label="Compromissos hoje"
              value={workStore.snapshot()?.status.google.connected ? todayEvents().length : "—"}
            />
            <StatCard
              icon={<GaugeIcon class="size-4" />}
              label="Maior consumo"
              value={usageBars().length > 0 ? `${highestUsage()}%` : "—"}
              tone={highestUsage() >= 90 ? "danger" : highestUsage() >= 70 ? "warning" : "success"}
              onClick={() => usage.openUsage(props.serverId, null)}
            />
          </div>

          <div class="work-grid dashboard-grid">
            <Card title="Foco de hoje" class="dashboard-span-2">
              <Show when={focus().length > 0} fallback={<p class="work-empty">Nada atrasado nem vencendo hoje. 🎯</p>}>
                <ul class="work-rows">
                  <For each={focus()}>{(item) => <WorkItemRow item={item} compact />}</For>
                </ul>
              </Show>
            </Card>
            <Card title="Agenda de hoje">
              <Show
                when={todayEvents().length > 0 || !workStore.snapshot()?.status.google.connected}
                fallback={<p class="work-empty">Dia livre na agenda.</p>}
              >
                <AgendaList days={0} limit={1} />
              </Show>
            </Card>

            <Card title="Conclusão da semana">
              <Gauge
                share={metrics().completion}
                label={`${metrics().doneWeek} concluídas`}
                caption={`${metrics().open.length} ainda abertas`}
              />
            </Card>
            <Card title="Tarefas por status">
              <DonutChart slices={metrics().groups} label="tarefas" size={132} />
            </Card>
            <Card title="Concluídas por dia">
              <ColumnChart columns={metrics().doneByDay} />
            </Card>

            <Card title="Agentes" class="dashboard-span-2">
              <div class="dashboard-agent-summary">
                <For each={["working", "failed", "limited", "idle"] as AgentState[]}>
                  {(state) => (
                    <span class="dashboard-agent-chip" data-state={state}>
                      {AGENT_STATE_LABEL[state]} <strong>{stateCount(state)}</strong>
                    </span>
                  )}
                </For>
              </div>
              <ul class="dashboard-agents">
                <For each={agentsShown()}>
                  {(entry) => (
                    <li data-state={entry.state}>
                      <span class="dashboard-agent-dot" aria-hidden="true" />
                      <span class="dashboard-agent-name">{entry.agent.name}</span>
                      <span class="dashboard-agent-title">{entry.agent.title}</span>
                      <span class="dashboard-agent-state">{AGENT_STATE_LABEL[entry.state]}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Card>
            <Card title="Consumo dos provedores">
              <BarList rows={usageBars()} empty="Nenhum provedor informa consumo." />
            </Card>

            <Card title="Abertas por projeto">
              <BarList rows={metrics().byContainer} />
            </Card>
            <Card title="Prazos dos próximos 7 dias">
              <ColumnChart columns={metrics().dueByDay} />
            </Card>
            <Card title="Rotinas">
              <div class="dashboard-mini-stats">
                <span>
                  <Workflow class="size-4" aria-hidden="true" /> <strong>{activeRoutines().length}</strong> ativas
                </span>
                <span>
                  <strong>{routines().length - activeRoutines().length}</strong> pausadas
                </span>
              </div>
              <BarList rows={routinesByAgent()} empty="Nenhuma rotina ativa." />
            </Card>

            <Card title="CRM">
              <Show when={crm()} fallback={<p class="work-empty">CRM indisponível neste servidor.</p>}>
                {(data) => (
                  <div class="dashboard-mini-stats" data-column="">
                    <span>
                      <UsersRound class="size-4" aria-hidden="true" /> <strong>{data().customers}</strong> clientes
                    </span>
                    <span>
                      <CircleCheck class="size-4" aria-hidden="true" /> <strong>{data().proposals}</strong> propostas
                      para revisar
                    </span>
                    <span>
                      <strong>{data().sources}</strong> fontes conectadas
                    </span>
                    <button type="button" class="work-button" onClick={() => usage.openCrm(props.serverId, null)}>
                      Abrir CRM
                    </button>
                  </div>
                )}
              </Show>
            </Card>
            <Card title="Novo compromisso" class="dashboard-span-2">
              <Show
                when={workStore.snapshot()?.status.google.connected}
                fallback={<p class="work-empty">Conecte o Google Agenda para criar compromissos daqui.</p>}
              >
                <NewEventForm />
              </Show>
            </Card>
          </div>
          <Show when={(workStore.snapshot()?.items ?? []).some(isOpen) === false && !workStore.busy()}>
            <p class="work-empty">Sem tarefas do Plane/Notion carregadas ainda.</p>
          </Show>
        </div>
      </div>
    </section>
  );
}
