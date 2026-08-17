/**
 * Catalog item an agent can list, offer, and transfer through the a2a
 * commerce surface. Deliberately generic: PX-402 does not interpret the
 * item beyond quantity accounting — `value` and `risk` are advisory
 * metadata the listing agent publishes for its counterparties.
 */
export interface InventoryItem {
  id: string;
  name: string;
  quantity: number;
  value: number;
  risk: "low" | "medium" | "high";
}
