/**
 * Pricing for the savings engine (Gate 6-A §3). Prices are DATA, not logic:
 * the preset table lives in pricing.json, each row dated (`price_as_of`) and
 * sourced. Prices change, so the table is versioned and every figure carries a
 * date the UI (6-B) renders as "prices as of YYYY-MM". A user can pick a preset
 * (the counterfactual: "if this hadn't run locally I'd have paid for GPT-4o")
 * or enter a manual override; the override is stored locally and BEATS the
 * preset (§3).
 *
 * `verified: false` marks a figure not confirmed against the provider's
 * official pricing page — honest rather than wrong. We never fabricate prices.
 */
import type { KV } from "./strikes";
import { createSafeBrowserKV } from "./strikes";
import pricingTable from "./pricing.json";

export interface PriceRow {
  id: string;
  label: string;
  /** USD per 1M input tokens. */
  input_per_1m: number;
  /** USD per 1M output tokens. */
  output_per_1m: number;
  /** Date the figure is believed valid, e.g. "2026-06" or "2025". */
  price_as_of: string;
  source: string;
  /** true only if confirmed against the provider's official pricing page. */
  verified: boolean;
}

export interface PricingTable {
  version: 1;
  currency: "USD";
  note: string;
  models: PriceRow[];
}

/** The bundled, dated preset table (pricing.json). */
export const PRESET_PRICING = pricingTable as PricingTable;

/** A resolved price basis — what computeSavings actually applies. */
export interface PriceBasis {
  /** Preset id, or "custom" for a manual override. */
  model: string;
  label: string;
  input_per_1m: number;
  output_per_1m: number;
  price_as_of: string;
  source: string;
  verified: boolean;
  /** true when a manual override produced this basis. */
  overridden: boolean;
}

/** User's manual price (takes precedence over any preset). */
export interface PriceOverride {
  label?: string;
  input_per_1m: number;
  output_per_1m: number;
}

const PRICING_KEY = "ludion.savings.pricing.v1";

interface PricingBlob {
  version: 1;
  /** Selected preset id (null = use default / first row). */
  selected: string | null;
  /** Manual override (null = none). When set, beats the preset. */
  override: PriceOverride | null;
}

function freshBlob(): PricingBlob {
  return { version: 1, selected: null, override: null };
}

/**
 * Holds the user's pricing selection and optional manual override, persisted
 * locally. Fail-open like StrikeStore (never throws; corrupt blob resets).
 */
export class PricingStore {
  constructor(private readonly kv: KV = createSafeBrowserKV()) {}

  private read(): PricingBlob {
    try {
      const raw = this.kv.getItem(PRICING_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PricingBlob;
        if (parsed.version === 1) {
          return {
            version: 1,
            selected: parsed.selected ?? null,
            override: parsed.override ?? null,
          };
        }
      }
    } catch {
      // fall through to fresh blob
    }
    return freshBlob();
  }

  private write(blob: PricingBlob): void {
    try {
      this.kv.setItem(PRICING_KEY, JSON.stringify(blob));
    } catch {
      // never throw
    }
  }

  /** Select a preset by id (clears nothing else). */
  selectModel(id: string): void {
    const blob = this.read();
    blob.selected = id;
    this.write(blob);
  }

  /** Set a manual override (beats preset). Pass null to clear it. */
  setOverride(override: PriceOverride | null): void {
    const blob = this.read();
    blob.override = override;
    this.write(blob);
  }

  /**
   * Resolve the effective price basis: override beats preset; otherwise the
   * selected preset; otherwise the first preset row. Pure table-driven.
   */
  resolveBasis(table: PricingTable = PRESET_PRICING): PriceBasis {
    const blob = this.read();
    if (blob.override) {
      return {
        model: "custom",
        label: blob.override.label ?? "Custom",
        input_per_1m: blob.override.input_per_1m,
        output_per_1m: blob.override.output_per_1m,
        price_as_of: new Date().toISOString().slice(0, 7),
        source: "manual override",
        verified: false,
        overridden: true,
      };
    }
    const row =
      (blob.selected != null ? table.models.find((m) => m.id === blob.selected) : undefined) ??
      table.models[0]!; // pricing.json always ships ≥1 row
    return {
      model: row.id,
      label: row.label,
      input_per_1m: row.input_per_1m,
      output_per_1m: row.output_per_1m,
      price_as_of: row.price_as_of,
      source: row.source,
      verified: row.verified,
      overridden: false,
    };
  }
}
