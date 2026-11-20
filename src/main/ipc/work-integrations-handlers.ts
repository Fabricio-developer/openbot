import type {
  WorkCreateEventInput,
  WorkDisconnectInput,
  WorkRefreshInput,
  WorkSetStatusInput,
} from "@openbot/contracts/ipc";
import type { WorkIntegrationsService } from "../work-integrations-service";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { isObject, requireString } from "./validation";

function decodeRefresh(value: unknown): WorkRefreshInput | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) throw new Error("Invalid refresh request.");
  return value.force === true ? { force: true } : {};
}

function decodeSetStatus(value: unknown): WorkSetStatusInput {
  if (!isObject(value)) throw new Error("Invalid status change.");
  return {
    itemId: requireString(value.itemId, "itemId", 400),
    statusId: requireString(value.statusId, "statusId", 200),
  };
}

function decodeCreateEvent(value: unknown): WorkCreateEventInput {
  if (!isObject(value)) throw new Error("Invalid event.");
  return {
    title: requireString(value.title, "title", 500),
    start: requireString(value.start, "start", 64),
    end: requireString(value.end, "end", 64),
  };
}

function decodeSource(value: unknown): WorkDisconnectInput {
  if (value === "plane" || value === "notion" || value === "google") return value;
  throw new Error("Invalid integration.");
}

export function workIntegrationsIpcHandlers({
  workIntegrations,
}: {
  workIntegrations: WorkIntegrationsService;
}): Pick<IpcGroupHandlers, "workIntegrations"> {
  return {
    workIntegrations: {
      status: handler(() => workIntegrations.status()),
      importLocal: handler(() => workIntegrations.importLocal()),
      refresh: payloadHandler(decodeRefresh, (input) => workIntegrations.refresh(input?.force === true)),
      setStatus: payloadHandler(decodeSetStatus, (input) => workIntegrations.setStatus(input)),
      connectGoogle: handler(() => workIntegrations.connectGoogle()),
      createEvent: payloadHandler(decodeCreateEvent, (input) => workIntegrations.createEvent(input)),
      disconnect: payloadHandler(decodeSource, (source) => workIntegrations.disconnect(source)),
    },
  };
}
