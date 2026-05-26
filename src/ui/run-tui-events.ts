import type { RoadrunnerRunEvent } from "../application/runner.js";

export function eventMessage(event: RoadrunnerRunEvent): string {
  if (event.type === "provider-start") return `provider started role=${event.role} pid=${event.pid ?? "n/a"} log=${event.logPath}`;
  if ("step" in event && event.step) return `${event.type} ${event.step.id}`;
  return event.type;
}

export function eventPayload(event: RoadrunnerRunEvent): Record<string, unknown> {
  if ("step" in event && event.step) return { stepId: event.step.id };
  return {};
}
