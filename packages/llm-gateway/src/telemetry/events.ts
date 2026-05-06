import { GatewayRequestEvent } from "../types.js";

export class EventStore {
  private readonly events: GatewayRequestEvent[] = [];

  append(event: GatewayRequestEvent): void {
    this.events.push(event);
    if (this.events.length > 5000) this.events.shift();
  }

  recent(limit = 100): GatewayRequestEvent[] {
    return this.events.slice(-limit).reverse();
  }

  all(): GatewayRequestEvent[] {
    return [...this.events];
  }
}
