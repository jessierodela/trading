import type { TradeIntent, TradeIntentListFilter, TradeIntentStatus } from "./types";

export interface TradeIntentStore {
  insertIntent(intent: TradeIntent): Promise<TradeIntent>;
  fetchIntent(id: string): Promise<TradeIntent | null>;
  listIntents(filter?: TradeIntentListFilter): Promise<TradeIntent[]>;
}

function copyIntent(intent: TradeIntent): TradeIntent {
  return structuredClone(intent);
}

function statusMatches(status: TradeIntentStatus, filter: TradeIntentListFilter["status"]): boolean {
  if (filter === undefined) return true;
  return Array.isArray(filter) ? filter.includes(status) : filter === status;
}

function matchesFilter(intent: TradeIntent, filter: TradeIntentListFilter): boolean {
  return (
    (filter.symbol === undefined || intent.symbol === filter.symbol) &&
    (filter.exchange === undefined || intent.exchange === filter.exchange) &&
    (filter.timeframe === undefined || intent.timeframe === filter.timeframe) &&
    (filter.strategyId === undefined || intent.strategyId === filter.strategyId) &&
    (filter.direction === undefined || intent.direction === filter.direction) &&
    statusMatches(intent.status, filter.status) &&
    (filter.fromTs === undefined || intent.ts >= filter.fromTs) &&
    (filter.toTs === undefined || intent.ts < filter.toTs)
  );
}

export class InMemoryTradeIntentStore implements TradeIntentStore {
  private readonly intents = new Map<string, TradeIntent>();
  private nextId = 1;

  async insertIntent(intent: TradeIntent): Promise<TradeIntent> {
    const id = intent.id ?? `memory-${this.nextId++}`;
    if (this.intents.has(id)) throw new Error(`duplicate trade intent id: ${id}`);
    const stored = copyIntent({ ...intent, id });
    this.intents.set(id, stored);
    return copyIntent(stored);
  }

  async fetchIntent(id: string): Promise<TradeIntent | null> {
    const intent = this.intents.get(id);
    return intent ? copyIntent(intent) : null;
  }

  async listIntents(filter: TradeIntentListFilter = {}): Promise<TradeIntent[]> {
    return [...this.intents.values()]
      .filter((intent) => matchesFilter(intent, filter))
      .sort((a, b) => (a.createdAt ?? a.ts).localeCompare(b.createdAt ?? b.ts) || (a.id ?? "").localeCompare(b.id ?? ""))
      .map(copyIntent);
  }
}
