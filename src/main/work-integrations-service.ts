// Work integrations (custom fork): Plane and Notion tasks and Google Calendar events for the Tasks tab and the
// Dashboard. Credentials stay in one file encrypted with OpenBot's secret storage key; nothing leaves this computer
// except the calls to the services themselves.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  WorkCalendarEvent,
  WorkCreateEventInput,
  WorkDisconnectInput,
  WorkIntegrationsStatus,
  WorkItem,
  WorkSetStatusInput,
  WorkSnapshot,
  WorkStatusGroup,
  WorkStatusOption,
} from "@openbot/contracts/ipc";
import { createOpenBotLogger, registerSecretValue } from "@openbot/logging";

const logger = createOpenBotLogger("work-integrations");

export const WORK_INTEGRATIONS_FILE = "openbot-work-integrations-v1.json";
const WORK_SNAPSHOT_FILE = "openbot-work-snapshot-v1.json";
const CACHE_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 25_000;
const PLANE_CONCURRENCY = 3;
const DONE_KEEP_DAYS = 30;
const CALENDAR_DAYS = 14;
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

interface SecretCipher {
  encrypt: (value: string) => Buffer;
  decrypt: (value: Buffer) => string;
}

interface PlaneConfig {
  baseUrl: string;
  apiKey: string;
  workspaces: string[];
}

interface NotionSourceConfig {
  id: string;
  name: string;
  workspace: string;
  token: string;
  /** `mirror` is the Notion copy of Plane tasks: not listed, only kept in step when a Plane status changes. */
  role: "tasks" | "mirror";
}

interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
  email?: string;
}

interface StoredRecord {
  plane?: PlaneConfig;
  notion?: NotionSourceConfig[];
  google?: GoogleConfig;
}

interface PlaneItemRef {
  workspace: string;
  project: string;
  issue: string;
}

interface NotionSchema {
  titleProp: string | null;
  statusProp: { name: string; type: "status" | "select" } | null;
  dateProp: string | null;
  priorityProp: string | null;
  options: WorkStatusOption[];
}

function emptyStatus(): WorkIntegrationsStatus {
  return {
    plane: { connected: false, detail: [], error: null },
    notion: { connected: false, detail: [], error: null },
    google: { connected: false, detail: [], error: null, canConnect: false },
    importable: [],
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits out a service's per-minute limit (Plane sends `x-ratelimit-remaining` and `x-ratelimit-reset`). */
class RateGate {
  #resetAt = 0;
  #remaining = Number.POSITIVE_INFINITY;

  async wait(): Promise<void> {
    if (this.#remaining > 1 || Date.now() >= this.#resetAt) return;
    await sleep(Math.min(70_000, this.#resetAt - Date.now() + 500));
    this.#remaining = Number.POSITIVE_INFINITY;
  }

  note(response: Response): void {
    const remaining = Number(response.headers.get("x-ratelimit-remaining"));
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(remaining) && response.headers.has("x-ratelimit-remaining")) this.#remaining = remaining;
    if (Number.isFinite(reset) && reset > 0) this.#resetAt = reset > 1e12 ? reset : reset * 1000;
    if (response.status === 429) {
      this.#remaining = 0;
      if (this.#resetAt <= Date.now()) this.#resetAt = Date.now() + 60_000;
    }
  }
}

async function fetchJson(url: string, init: RequestInit = {}, gate?: RateGate): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    await gate?.wait();
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    gate?.note(response);
    if (response.status === 429 && gate && attempt < 3) {
      await response.body?.cancel();
      continue;
    }
    return readJson(response);
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: { message?: string } | string; detail?: string };
      detail =
        parsed.message ??
        (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ??
        parsed.detail ??
        detail;
    } catch {
      /* not JSON */
    }
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }
  return text ? JSON.parse(text) : null;
}

async function mapLimit<Input, Output>(
  inputs: readonly Input[],
  limit: number,
  run: (input: Input) => Promise<Output>,
): Promise<Output[]> {
  const results: Output[] = new Array(inputs.length);
  let next = 0;
  const worker = async () => {
    while (next < inputs.length) {
      const index = next++;
      results[index] = await run(inputs[index] as Input);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, worker));
  return results;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function guessGroup(name: string): WorkStatusGroup {
  const text = name.toLowerCase();
  if (/(cancel|descart|arquiv)/.test(text)) return "cancelled";
  if (/(done|conclu|feito|complet|finaliz|entreg|publicad)/.test(text)) return "done";
  if (/(progress|andamento|doing|fazendo|qa|review|revis|teste|produz)/.test(text)) return "doing";
  if (/backlog|ideia|someday/.test(text)) return "backlog";
  return "todo";
}

const PLANE_GROUPS: Record<string, WorkStatusGroup> = {
  backlog: "backlog",
  unstarted: "todo",
  started: "doing",
  completed: "done",
  cancelled: "cancelled",
};

function recentEnough(iso: string | null): boolean {
  if (!iso) return false;
  return Date.now() - Date.parse(iso) < DONE_KEEP_DAYS * 86_400_000;
}

// ---------- local setup discovery (NotchMestre and busca-vagas on this computer) ----------

const MEMORY_DIRS = [
  join(homedir(), "Documents", "trabalho", "gestao-agentes-ide", "desenvolvimento", "memory"),
  join(homedir(), ".config", "notchmestre", "memory-work", "corpus"),
];
const AI_LIMITS_DIR = join(homedir(), ".config", "ai-limits");

function readNotes(): string[] {
  const texts: string[] = [];
  for (const dir of MEMORY_DIRS) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!/plane|notion/i.test(name) || !name.endsWith(".md")) continue;
      try {
        texts.push(readFileSync(join(dir, name), "utf8"));
      } catch {
        /* unreadable note */
      }
    }
  }
  return texts;
}

function findBuscaVagasEnv(): string | null {
  const roots = [join(homedir(), "Documents"), join(homedir(), "Projects"), homedir()];
  const seen = new Set<string>();
  const visit = (dir: string, depth: number): string | null => {
    if (depth < 0 || seen.has(dir)) return null;
    seen.add(dir);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return null;
    }
    if (dir.endsWith("busca-vagas") && names.includes(".env")) return join(dir, ".env");
    for (const name of names) {
      if (name.startsWith(".") || name === "node_modules" || name === "Library") continue;
      const path = join(dir, name);
      try {
        if (!statSync(path).isDirectory()) continue;
      } catch {
        continue;
      }
      const found = visit(path, depth - 1);
      if (found) return found;
    }
    return null;
  };
  for (const root of roots) {
    const found = visit(root, 4);
    if (found) return found;
  }
  return null;
}

function readEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match?.[1]) values[match[1]] = (match[2] ?? "").replace(/^["']|["']$/g, "");
  }
  return values;
}

function discoverPlane(notes: string[]): PlaneConfig | null {
  let apiKey: string | null = null;
  let host: string | null = null;
  const workspaces = new Set<string>();
  for (const note of notes) {
    apiKey ??= /plane_api_[A-Za-z0-9]+/.exec(note)?.[0] ?? null;
    for (const match of note.matchAll(/https:\/\/(plane\.[a-z0-9.-]+)\/([a-z0-9-]+)(?=[/\s|)`]|$)/g)) {
      host ??= match[1] ?? null;
      const slug = match[2];
      if (slug && slug !== "api" && slug !== "god-mode") workspaces.add(slug);
    }
  }
  if (!apiKey || !host) return null;
  return { baseUrl: `https://${host}`, apiKey, workspaces: [...workspaces] };
}

function discoverNotion(notes: string[]): NotionSourceConfig[] {
  const configPath = join(AI_LIMITS_DIR, "notion.json");
  if (!existsSync(configPath)) return [];
  const config = record(JSON.parse(readFileSync(configPath, "utf8")));
  const sources: NotionSourceConfig[] = [];
  const tokens = new Map<string, string>();
  for (const workspace of Array.isArray(config.workspaces) ? config.workspaces : []) {
    const ws = record(workspace);
    const name = str(ws.name) ?? "Notion";
    const tokenFile = str(ws.token);
    if (!tokenFile) continue;
    const tokenPath = join(AI_LIMITS_DIR, tokenFile);
    if (!existsSync(tokenPath)) continue;
    const token = readFileSync(tokenPath, "utf8").trim();
    tokens.set(name, token);
    for (const item of Array.isArray(ws.sources) ? ws.sources : []) {
      const source = record(item);
      const id = str(source.id);
      const sourceName = str(source.name) ?? "Tarefas";
      if (!id) continue;
      const kind = str(source.kind);
      if (kind === "tasks" || (!kind && /tarefa|task/i.test(sourceName)))
        sources.push({ id, name: sourceName, workspace: name, token, role: "tasks" });
    }
  }
  for (const note of notes) {
    const match = /Plane Tasks[\s\S]{0,200}?database ([0-9a-f]{32})/i.exec(note);
    const workspace = /workspace "([^"]+)"/i.exec(note)?.[1] ?? "GTD";
    const token = tokens.get(workspace) ?? tokens.values().next().value;
    if (match?.[1] && token && !sources.some((source) => source.id === match[1])) {
      sources.push({ id: match[1], name: "Plane Tasks", workspace, token, role: "mirror" });
      break;
    }
  }
  return sources;
}

function discoverGoogle(): GoogleConfig | null {
  const envPath = findBuscaVagasEnv();
  if (!envPath) return null;
  const env = readEnvFile(envPath);
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: env.GOOGLE_REDIRECT_URI || "http://localhost:3000/api/gmail/callback",
  };
}

// ---------- service ----------

export class WorkIntegrationsService {
  readonly #path: string;
  readonly #snapshotPath: string;
  readonly #cipher: SecretCipher;
  readonly #openExternal: (url: string) => void;
  #record: StoredRecord = {};
  #snapshot: WorkSnapshot | null = null;
  #loading: Promise<WorkSnapshot> | null = null;
  #planeMe: string | null = null;
  #planeStates = new Map<string, WorkStatusOption[]>();
  #notionSchemas = new Map<string, NotionSchema>();
  #errors: Partial<Record<WorkDisconnectInput, string>> = {};
  #googleServer: Server | null = null;
  readonly #planeGate = new RateGate();

  constructor(options: { userData: string; cipher: SecretCipher; openExternal: (url: string) => void }) {
    this.#path = join(options.userData, WORK_INTEGRATIONS_FILE);
    this.#snapshotPath = join(options.userData, WORK_SNAPSHOT_FILE);
    this.#cipher = options.cipher;
    this.#openExternal = options.openExternal;
  }

  async load(): Promise<void> {
    try {
      const file = record(JSON.parse(await readFile(this.#path, "utf8")));
      const data = str(file.data);
      if (data) this.#record = JSON.parse(this.#cipher.decrypt(Buffer.from(data, "base64"))) as StoredRecord;
      this.#registerSecrets();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        logger.warn("Could not read the work integrations file:", errorText(error));
    }
    try {
      const saved = record(JSON.parse(await readFile(this.#snapshotPath, "utf8")));
      if (Array.isArray(saved.items) && Array.isArray(saved.events))
        this.#snapshot = {
          status: this.status(),
          items: saved.items as WorkItem[],
          events: saved.events as WorkCalendarEvent[],
          fetchedAt: str(saved.fetchedAt),
          errors: [],
        };
    } catch {
      /* no saved copy yet */
    }
  }

  #registerSecrets(): void {
    const values = [
      this.#record.plane?.apiKey,
      this.#record.google?.clientSecret,
      this.#record.google?.refreshToken,
      this.#record.google?.accessToken,
      ...(this.#record.notion ?? []).map((source) => source.token),
    ];
    for (const value of values) if (value) registerSecretValue(value);
  }

  async #save(): Promise<void> {
    this.#registerSecrets();
    await mkdir(dirname(this.#path), { recursive: true });
    const data = this.#cipher.encrypt(JSON.stringify(this.#record)).toString("base64");
    const temporary = `${this.#path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, data }), { mode: 0o600 });
    await rename(temporary, this.#path);
  }

  status(): WorkIntegrationsStatus {
    const status = emptyStatus();
    const plane = this.#record.plane;
    if (plane) status.plane = { connected: true, detail: plane.workspaces, error: this.#errors.plane ?? null };
    const notion = this.#record.notion ?? [];
    if (notion.length > 0)
      status.notion = {
        connected: true,
        detail: notion.map(
          (source) => `${source.workspace} · ${source.name}${source.role === "mirror" ? " (espelho)" : ""}`,
        ),
        error: this.#errors.notion ?? null,
      };
    const google = this.#record.google;
    status.google = {
      connected: Boolean(google?.refreshToken),
      detail: google?.email ? [google.email] : [],
      error: this.#errors.google ?? null,
      canConnect: Boolean(google),
    };
    status.importable = this.#importable();
    return status;
  }

  #importable(): string[] {
    const found: string[] = [];
    try {
      const notes = readNotes();
      if (!this.#record.plane && discoverPlane(notes)) found.push("plane");
      if (!this.#record.notion?.length && discoverNotion(notes).length > 0) found.push("notion");
      if (!this.#record.google && discoverGoogle()) found.push("google");
    } catch (error) {
      logger.warn("Could not look for local setups:", errorText(error));
    }
    return found;
  }

  async importLocal(): Promise<WorkIntegrationsStatus> {
    const notes = readNotes();
    const plane = discoverPlane(notes);
    if (plane) {
      const working: string[] = [];
      for (const workspace of plane.workspaces) {
        try {
          await this.#plane(plane, `/workspaces/${workspace}/projects/?per_page=1`);
          working.push(workspace);
        } catch {
          /* not a workspace this key can read */
        }
      }
      if (working.length > 0) this.#record.plane = { ...plane, workspaces: working };
    }
    const notion = discoverNotion(notes);
    if (notion.length > 0) this.#record.notion = notion;
    const google = discoverGoogle();
    if (google)
      this.#record.google = {
        ...google,
        ...(this.#record.google?.clientId === google.clientId ? this.#record.google : {}),
      };
    await this.#save();
    this.#snapshot = null;
    return this.status();
  }

  async disconnect(source: WorkDisconnectInput): Promise<WorkIntegrationsStatus> {
    if (source === "google" && this.#record.google) {
      const {
        refreshToken: _refresh,
        accessToken: _access,
        expiresAt: _expires,
        email: _email,
        ...rest
      } = this.#record.google;
      this.#record.google = rest;
    } else delete this.#record[source];
    delete this.#errors[source];
    await this.#save();
    this.#snapshot = null;
    return this.status();
  }

  /** Fresh copy when forced; otherwise the saved copy at once, renewed in the background when it is old. */
  async refresh(force = false): Promise<WorkSnapshot> {
    const current = this.#snapshot;
    const fresh = current?.fetchedAt && Date.now() - Date.parse(current.fetchedAt) < CACHE_MS;
    if (!force && current && fresh) return { ...current, status: this.status() };
    this.#loading ??= this.#load().finally(() => {
      this.#loading = null;
    });
    if (!force && current) {
      this.#loading.catch(() => {});
      return { ...current, status: this.status() };
    }
    return this.#loading;
  }

  /** True while a background read is running, so the screen can show that newer data is coming. */
  loading(): boolean {
    return this.#loading !== null;
  }

  async #load(): Promise<WorkSnapshot> {
    const errors: string[] = [];
    const run = async <T>(source: WorkDisconnectInput, label: string, task: () => Promise<T>, fallback: T) => {
      try {
        const value = await task();
        delete this.#errors[source];
        return value;
      } catch (error) {
        this.#errors[source] = errorText(error);
        errors.push(`${label}: ${errorText(error)}`);
        return fallback;
      }
    };
    const [plane, notion, events] = await Promise.all([
      this.#record.plane ? run("plane", "Plane", () => this.#planeItems(), []) : [],
      this.#record.notion?.length ? run("notion", "Notion", () => this.#notionItems(), []) : [],
      this.#record.google?.refreshToken ? run("google", "Google Calendar", () => this.#calendarEvents(), []) : [],
    ]);
    this.#snapshot = {
      status: this.status(),
      items: [...plane, ...notion],
      events,
      fetchedAt: new Date().toISOString(),
      errors,
    };
    const saved = {
      version: 1,
      items: this.#snapshot.items,
      events: this.#snapshot.events,
      fetchedAt: this.#snapshot.fetchedAt,
    };
    await writeFile(this.#snapshotPath, JSON.stringify(saved), {
      mode: 0o600,
    }).catch((error: unknown) => logger.warn("Could not save the work snapshot:", errorText(error)));
    return this.#snapshot;
  }

  async setStatus(input: WorkSetStatusInput): Promise<WorkItem> {
    const item = this.#snapshot?.items.find((candidate) => candidate.id === input.itemId);
    if (!item) throw new Error("Tarefa não encontrada. Atualize a lista e tente de novo.");
    const option = item.statusOptions.find((candidate) => candidate.id === input.statusId);
    if (!option) throw new Error("Status inválido para esta tarefa.");
    if (item.source === "plane") {
      const plane = this.#requirePlane();
      const ref = this.#planeRef(item.id);
      await this.#plane(plane, `/workspaces/${ref.workspace}/projects/${ref.project}/issues/${ref.issue}/`, {
        method: "PATCH",
        body: JSON.stringify({ state: option.id }),
      });
      await this.#mirrorPlaneStatus(ref.issue, item.ref, option).catch((error: unknown) =>
        logger.warn("Could not mirror the Plane status in Notion:", errorText(error)),
      );
    } else {
      const [, databaseId, pageId] = item.id.split(":");
      const source = this.#record.notion?.find((candidate) => candidate.id === databaseId);
      const schema = databaseId ? this.#notionSchemas.get(databaseId) : undefined;
      if (!source || !schema?.statusProp || !pageId) throw new Error("Esta tabela do Notion não tem status editável.");
      await this.#notion(source.token, `/pages/${pageId}`, {
        method: "PATCH",
        body: JSON.stringify({
          properties: { [schema.statusProp.name]: { [schema.statusProp.type]: { id: option.id } } },
        }),
      });
    }
    const updated: WorkItem = {
      ...item,
      status: option.name,
      statusId: option.id,
      statusGroup: option.group,
      updatedAt: new Date().toISOString(),
    };
    if (this.#snapshot)
      this.#snapshot = {
        ...this.#snapshot,
        items: this.#snapshot.items.map((candidate) => (candidate.id === item.id ? updated : candidate)),
      };
    return updated;
  }

  // ---------- Plane ----------

  #requirePlane(): PlaneConfig {
    const plane = this.#record.plane;
    if (!plane) throw new Error("Plane não está conectado.");
    return plane;
  }

  #plane(plane: PlaneConfig, path: string, init: RequestInit = {}): Promise<unknown> {
    return fetchJson(
      `${plane.baseUrl}/api/v1${path}`,
      { ...init, headers: { "X-API-Key": plane.apiKey, "Content-Type": "application/json", ...init.headers } },
      this.#planeGate,
    );
  }

  #planeRef(id: string): PlaneItemRef {
    const [, workspace, project, issue] = id.split(":");
    if (!workspace || !project || !issue) throw new Error("Tarefa do Plane inválida.");
    return { workspace, project, issue };
  }

  async #planeItems(): Promise<WorkItem[]> {
    const plane = this.#requirePlane();
    this.#planeMe ??= str(record(await this.#plane(plane, "/users/me/")).id);
    const me = this.#planeMe;
    const projects: { workspace: string; id: string; name: string; identifier: string }[] = [];
    for (const workspace of plane.workspaces) {
      const page = record(await this.#plane(plane, `/workspaces/${workspace}/projects/?per_page=100`));
      const results = Array.isArray(page.results) ? page.results : Array.isArray(page) ? page : [];
      for (const project of results) {
        const value = record(project);
        const id = str(value.id);
        if (id && !value.archived_at && value.is_member !== false)
          projects.push({
            workspace,
            id,
            name: str(value.name) ?? "Projeto",
            identifier: str(value.identifier) ?? "",
          });
      }
    }
    const lists = await mapLimit(projects, PLANE_CONCURRENCY, async (project) => {
      try {
        const base = `/workspaces/${project.workspace}/projects/${project.id}`;
        let states = this.#planeStates.get(project.id);
        if (!states) {
          const page = record(await this.#plane(plane, `${base}/states/`));
          const results = Array.isArray(page.results) ? page.results : [];
          states = results.map((state) => {
            const value = record(state);
            return {
              id: str(value.id) ?? "",
              name: str(value.name) ?? "",
              group: PLANE_GROUPS[str(value.group) ?? ""] ?? "todo",
              color: str(value.color),
            };
          });
          this.#planeStates.set(project.id, states);
        }
        const items: WorkItem[] = [];
        let cursor: string | null = null;
        for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
          const query: string = `?per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
          const page = record(await this.#plane(plane, `${base}/issues/${query}`));
          for (const issue of Array.isArray(page.results) ? page.results : []) {
            const value = record(issue);
            const assignees = Array.isArray(value.assignees) ? value.assignees : [];
            if (me && !assignees.includes(me)) continue;
            if (value.archived_at || value.is_draft) continue;
            const state = states.find((candidate) => candidate.id === value.state);
            const group = state?.group ?? "todo";
            if (
              (group === "done" || group === "cancelled") &&
              !recentEnough(str(value.completed_at) ?? str(value.updated_at))
            )
              continue;
            const issueId = str(value.id) ?? "";
            items.push({
              id: `plane:${project.workspace}:${project.id}:${issueId}`,
              source: "plane",
              title: str(value.name) ?? "(sem título)",
              url: `${plane.baseUrl}/${project.workspace}/projects/${project.id}/issues/${issueId}`,
              workspace: project.workspace,
              container: project.name,
              ref:
                project.identifier && typeof value.sequence_id === "number"
                  ? `${project.identifier}-${value.sequence_id}`
                  : null,
              status: state?.name ?? "—",
              statusId: state?.id ?? null,
              statusGroup: group,
              statusOptions: states,
              priority: str(value.priority) === "none" ? null : str(value.priority),
              due: str(value.target_date),
              updatedAt: str(value.updated_at),
            });
          }
          cursor = page.next_page_results === true ? str(page.next_cursor) : null;
          if (!cursor) break;
        }
        return items;
      } catch (error) {
        logger.warn(`Could not read Plane project ${project.name}:`, errorText(error));
        return [];
      }
    });
    return lists.flat();
  }

  async #mirrorPlaneStatus(issueId: string, ref: string | null, option: WorkStatusOption): Promise<void> {
    const mirror = this.#record.notion?.find((source) => source.role === "mirror");
    if (!mirror) return;
    const schema = await this.#notionSchema(mirror);
    if (!schema.statusProp) return;
    const filters: unknown[] = [{ property: "Plane ID", rich_text: { equals: issueId } }];
    if (ref) filters.push({ property: "Plane ID", rich_text: { equals: ref } });
    const page = record(
      await this.#notion(mirror.token, `/databases/${mirror.id}/query`, {
        method: "POST",
        body: JSON.stringify({ filter: { or: filters }, page_size: 5 }),
      }),
    );
    const target =
      schema.options.find((candidate) => candidate.name.toLowerCase() === option.name.toLowerCase()) ??
      schema.options.find((candidate) => candidate.group === option.group);
    if (!target) return;
    for (const row of Array.isArray(page.results) ? page.results : []) {
      const pageId = str(record(row).id);
      if (!pageId) continue;
      await this.#notion(mirror.token, `/pages/${pageId}`, {
        method: "PATCH",
        body: JSON.stringify({
          properties: { [schema.statusProp.name]: { [schema.statusProp.type]: { id: target.id } } },
        }),
      });
    }
  }

  // ---------- Notion ----------

  #notion(token: string, path: string, init: RequestInit = {}): Promise<unknown> {
    return fetchJson(`https://api.notion.com/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  }

  async #notionSchema(source: NotionSourceConfig): Promise<NotionSchema> {
    const cached = this.#notionSchemas.get(source.id);
    if (cached) return cached;
    const database = record(await this.#notion(source.token, `/databases/${source.id}`));
    const properties = record(database.properties);
    const schema: NotionSchema = { titleProp: null, statusProp: null, dateProp: null, priorityProp: null, options: [] };
    const entries = Object.entries(properties).map(([name, value]) => [name, record(value)] as const);
    for (const [name, value] of entries) if (value.type === "title") schema.titleProp = name;
    const status =
      entries.find(([name, value]) => value.type === "status" && /status/i.test(name)) ??
      entries.find(([, value]) => value.type === "status") ??
      entries.find(([name, value]) => value.type === "select" && /status|estado|etapa/i.test(name));
    if (status) {
      const [name, value] = status;
      const type = value.type === "status" ? "status" : "select";
      schema.statusProp = { name, type };
      const config = record(value[type]);
      const groups = Array.isArray(config.groups) ? config.groups.map(record) : [];
      for (const option of Array.isArray(config.options) ? config.options.map(record) : []) {
        const id = str(option.id);
        const optionName = str(option.name);
        if (!id || !optionName) continue;
        const groupName = str(
          groups.find((group) => Array.isArray(group.option_ids) && group.option_ids.includes(id))?.name,
        );
        const group: WorkStatusGroup =
          groupName === "Complete" ? (/cancel/i.test(optionName) ? "cancelled" : "done") : guessGroup(optionName);
        schema.options.push({ id, name: optionName, group, color: str(option.color) });
      }
    }
    schema.dateProp =
      entries.find(([name, value]) => value.type === "date" && /prazo|due|date|data/i.test(name))?.[0] ??
      entries.find(([, value]) => value.type === "date")?.[0] ??
      null;
    schema.priorityProp =
      entries.find(
        ([name, value]) => (value.type === "select" || value.type === "status") && /priorid|priority/i.test(name),
      )?.[0] ?? null;
    this.#notionSchemas.set(source.id, schema);
    return schema;
  }

  async #notionItems(): Promise<WorkItem[]> {
    const sources = (this.#record.notion ?? []).filter((source) => source.role === "tasks");
    const lists = await Promise.all(
      sources.map(async (source) => {
        const schema = await this.#notionSchema(source);
        const items: WorkItem[] = [];
        let cursor: string | null = null;
        for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
          const body: Record<string, unknown> = {
            page_size: 100,
            sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
          };
          if (cursor) body.start_cursor = cursor;
          const page = record(
            await this.#notion(source.token, `/databases/${source.id}/query`, {
              method: "POST",
              body: JSON.stringify(body),
            }),
          );
          for (const row of Array.isArray(page.results) ? page.results : []) {
            const value = record(row);
            if (value.archived || value.in_trash) continue;
            const properties = record(value.properties);
            const title = schema.titleProp
              ? (Array.isArray(record(properties[schema.titleProp]).title)
                  ? (record(properties[schema.titleProp]).title as unknown[])
                  : []
                )
                  .map((part) => str(record(part).plain_text) ?? "")
                  .join("")
              : "";
            const statusValue = schema.statusProp
              ? record(record(properties[schema.statusProp.name])[schema.statusProp.type])
              : {};
            const statusId = str(statusValue.id);
            const option = schema.options.find((candidate) => candidate.id === statusId);
            const group = option?.group ?? "todo";
            const edited = str(value.last_edited_time);
            if ((group === "done" || group === "cancelled") && !recentEnough(edited)) continue;
            const date = schema.dateProp ? record(record(properties[schema.dateProp]).date) : {};
            const priority = schema.priorityProp
              ? str(
                  record(
                    record(properties[schema.priorityProp]).select ?? record(properties[schema.priorityProp]).status,
                  ).name,
                )
              : null;
            items.push({
              id: `notion:${source.id}:${str(value.id) ?? ""}`,
              source: "notion",
              title: title || "(sem título)",
              url: str(value.url) ?? "",
              workspace: source.workspace,
              container: source.name,
              ref: null,
              status: option?.name ?? str(statusValue.name) ?? "—",
              statusId,
              statusGroup: group,
              statusOptions: schema.options,
              priority,
              due: str(date.start)?.slice(0, 10) ?? null,
              updatedAt: edited,
            });
          }
          cursor = page.has_more === true ? str(page.next_cursor) : null;
          if (!cursor) break;
        }
        return items;
      }),
    );
    return lists.flat();
  }

  // ---------- Google Calendar ----------

  async connectGoogle(): Promise<WorkIntegrationsStatus> {
    const google = this.#record.google;
    if (!google) throw new Error("Nenhum app Google encontrado. Use “Importar configurações” primeiro.");
    const redirect = new URL(google.redirectUri);
    if (redirect.hostname !== "localhost" && redirect.hostname !== "127.0.0.1")
      throw new Error("O endereço de retorno do Google precisa ser local (localhost).");
    const state = crypto.randomUUID();
    const code = await new Promise<string>((resolve, reject) => {
      this.#googleServer?.close();
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", google.redirectUri);
        if (url.pathname !== redirect.pathname) {
          response.writeHead(404).end();
          return;
        }
        const ok = url.searchParams.get("state") === state && url.searchParams.get("code");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(
          `<html><body style="font-family:system-ui;background:#1c1c1c;color:#eee;display:grid;place-items:center;height:100vh"><p>${
            ok
              ? "Google Calendar conectado ao OpenBot. Pode fechar esta aba."
              : "Não foi possível conectar. Volte ao OpenBot."
          }</p></body></html>`,
        );
        clearTimeout(timer);
        server.close();
        this.#googleServer = null;
        const error = url.searchParams.get("error");
        if (ok) resolve(url.searchParams.get("code") as string);
        else reject(new Error(error ? `Google recusou: ${error}` : "Resposta do Google inválida."));
      });
      const timer = setTimeout(() => {
        server.close();
        this.#googleServer = null;
        reject(new Error("O login no Google não terminou em 5 minutos."));
      }, 5 * 60_000);
      server.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          new Error(
            error.code === "EADDRINUSE"
              ? `A porta ${redirect.port} está em uso (o busca-vagas está rodando?). Feche-o e tente de novo.`
              : errorText(error),
          ),
        );
      });
      server.listen(
        Number(redirect.port || 80),
        redirect.hostname === "localhost" ? "127.0.0.1" : redirect.hostname,
        () => {
          const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
          auth.searchParams.set("client_id", google.clientId);
          auth.searchParams.set("redirect_uri", google.redirectUri);
          auth.searchParams.set("response_type", "code");
          auth.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
          auth.searchParams.set("access_type", "offline");
          auth.searchParams.set("prompt", "consent");
          auth.searchParams.set("state", state);
          this.#openExternal(auth.toString());
        },
      );
      this.#googleServer = server;
    });
    const token = record(
      await fetchJson("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: google.clientId,
          client_secret: google.clientSecret,
          redirect_uri: google.redirectUri,
          grant_type: "authorization_code",
        }),
      }),
    );
    const refreshToken = str(token.refresh_token);
    if (!refreshToken) throw new Error("O Google não devolveu acesso permanente. Tente conectar de novo.");
    let email: string | undefined;
    const idToken = str(token.id_token);
    if (idToken) {
      try {
        email =
          str(record(JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"))).email) ??
          undefined;
      } catch {
        /* no email */
      }
    }
    this.#record.google = {
      ...google,
      refreshToken,
      accessToken: str(token.access_token) ?? undefined,
      expiresAt: Date.now() + (typeof token.expires_in === "number" ? token.expires_in : 3000) * 1000,
      ...(email ? { email } : {}),
    };
    delete this.#errors.google;
    await this.#save();
    this.#snapshot = null;
    return this.status();
  }

  async #googleToken(): Promise<string> {
    const google = this.#record.google;
    if (!google?.refreshToken) throw new Error("Google Calendar não está conectado.");
    if (google.accessToken && (google.expiresAt ?? 0) > Date.now() + 60_000) return google.accessToken;
    const token = record(
      await fetchJson("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: google.clientId,
          client_secret: google.clientSecret,
          refresh_token: google.refreshToken,
          grant_type: "refresh_token",
        }),
      }),
    );
    const accessToken = str(token.access_token);
    if (!accessToken) throw new Error("O Google não renovou o acesso. Conecte de novo.");
    google.accessToken = accessToken;
    google.expiresAt = Date.now() + (typeof token.expires_in === "number" ? token.expires_in : 3000) * 1000;
    await this.#save();
    return accessToken;
  }

  #google(path: string, init: RequestInit = {}): Promise<unknown> {
    return this.#googleToken().then((token) =>
      fetchJson(`https://www.googleapis.com/calendar/v3${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
      }),
    );
  }

  async #calendarEvents(): Promise<WorkCalendarEvent[]> {
    const list = record(await this.#google("/users/me/calendarList?minAccessRole=reader&maxResults=50"));
    const calendars = (Array.isArray(list.items) ? list.items.map(record) : [])
      .filter((calendar) => calendar.selected === true || calendar.primary === true)
      .slice(0, 10);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + CALENDAR_DAYS * 86_400_000);
    const lists = await Promise.all(
      calendars.map(async (calendar) => {
        const id = str(calendar.id);
        if (!id) return [];
        try {
          const query = new URLSearchParams({
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: "true",
            orderBy: "startTime",
            maxResults: "100",
          });
          const page = record(await this.#google(`/calendars/${encodeURIComponent(id)}/events?${query}`));
          return (Array.isArray(page.items) ? page.items.map(record) : [])
            .filter((event) => event.status !== "cancelled")
            .map((event) => this.#calendarEvent(event, str(calendar.summaryOverride) ?? str(calendar.summary) ?? id));
        } catch (error) {
          logger.warn("Could not read a calendar:", errorText(error));
          return [];
        }
      }),
    );
    return lists.flat().sort((left, right) => left.start.localeCompare(right.start));
  }

  #calendarEvent(event: Record<string, unknown>, calendar: string): WorkCalendarEvent {
    const start = record(event.start);
    const end = record(event.end);
    const allDay = Boolean(str(start.date)) && !str(start.dateTime);
    return {
      id: str(event.id) ?? crypto.randomUUID(),
      calendar,
      title: str(event.summary) ?? "(sem título)",
      start: str(start.dateTime) ?? str(start.date) ?? "",
      end: str(end.dateTime) ?? str(end.date) ?? "",
      allDay,
      url: str(event.htmlLink),
      location: str(event.location),
    };
  }

  async createEvent(input: WorkCreateEventInput): Promise<WorkCalendarEvent> {
    const title = input.title.trim();
    if (!title) throw new Error("Escreva o título do compromisso.");
    if (Number.isNaN(Date.parse(input.start)) || Number.isNaN(Date.parse(input.end)))
      throw new Error("Horário inválido.");
    const created = record(
      await this.#google("/calendars/primary/events", {
        method: "POST",
        body: JSON.stringify({
          summary: title,
          start: { dateTime: new Date(input.start).toISOString() },
          end: { dateTime: new Date(input.end).toISOString() },
        }),
      }),
    );
    const event = this.#calendarEvent(created, "Principal");
    if (this.#snapshot)
      this.#snapshot = {
        ...this.#snapshot,
        events: [...this.#snapshot.events, event].sort((left, right) => left.start.localeCompare(right.start)),
      };
    return event;
  }

  async dispose(): Promise<void> {
    this.#googleServer?.close();
    this.#googleServer = null;
  }

  /** Removes the stored credentials file (used only by tests and full resets). */
  async clear(): Promise<void> {
    this.#record = {};
    this.#snapshot = null;
    await rm(this.#path, { force: true });
    await rm(this.#snapshotPath, { force: true });
  }
}
