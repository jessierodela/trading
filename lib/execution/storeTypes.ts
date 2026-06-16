import type { QueryResult, QueryResultRow } from "pg";
import type {
  PaperFill,
  PaperOrder,
  PaperOrderListFilter,
  PaperPosition,
  PaperPositionListFilter,
} from "./types";

export interface PgQueryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface PaperTradingStore {
  insertOrder(order: PaperOrder): Promise<PaperOrder>;
  updateOrder(order: PaperOrder): Promise<PaperOrder>;
  fetchOrder(id: string): Promise<PaperOrder | null>;
  listOrders(filter?: PaperOrderListFilter): Promise<PaperOrder[]>;
  insertFill(fill: PaperFill): Promise<PaperFill>;
  fetchFill(orderId: string): Promise<PaperFill | null>;
  listFills(): Promise<PaperFill[]>;
  insertPosition(position: PaperPosition): Promise<PaperPosition>;
  updatePosition(position: PaperPosition): Promise<PaperPosition>;
  fetchPosition(id: string): Promise<PaperPosition | null>;
  listPositions(filter?: PaperPositionListFilter): Promise<PaperPosition[]>;
  aggregateRealizedPnl(): Promise<number>;
}
