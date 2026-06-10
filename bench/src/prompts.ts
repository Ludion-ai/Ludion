import type { PromptId } from "./schema";

export interface BenchPrompt {
  id: PromptId;
  /** Single user-turn content; adapters wrap it as one user chat message. */
  text: string;
  maxTokens: number;
}

/** P1: ~30-token instruction prompt. */
const SHORT_PROMPT = `Explain in three short paragraphs why the sky appears blue during the day but red or orange near sunrise and sunset. Keep the explanation simple.`;

/**
 * P2: ~1,500-token hardcoded lorem-like document + question.
 * Purpose: expose the known browser prefill weakness.
 * The document is fixed verbatim; do not regenerate or template it.
 */
const LONG_DOCUMENT = `The Meridian Freight Coordination System is an internal logistics platform operated by the fictional Aurelia Transport Consortium. It was introduced to replace a patchwork of regional dispatch tools that had grown incompatible over two decades of acquisitions. The system is organized into three tiers. Tier One, called the Continental Spine, manages long-haul corridors between major distribution hubs and is responsible for assigning locomotive and line-haul truck capacity on routes that exceed eight hundred kilometers. Tier Two, called the Regional Mesh, coordinates movements between hubs and satellite depots within a single administrative region, typically journeys of fifty to eight hundred kilometers. Tier Three, called the Local Loop, schedules last-mile deliveries, courier handoffs, and depot yard movements. Each tier maintains its own scheduling ledger, but all three publish to a shared event stream so that downstream consumers can reconstruct the state of any shipment without querying the tiers directly.

Cold-chain freight, meaning any cargo that must remain within a controlled temperature band, is handled exclusively by the Regional Mesh, regardless of distance. This is a deliberate design decision: the consortium found that long-haul corridors could not guarantee refrigeration unit servicing intervals, while local couriers lacked certified handling equipment. When a cold-chain shipment must travel more than eight hundred kilometers, the Regional Mesh decomposes the journey into chained regional segments with mandatory inspection stops at certified depots. Each segment is assigned a thermal custodian, a staff role created in the fourth revision of the operating charter, who signs the temperature log before the shipment may proceed. Failure to obtain a custodian signature within ninety minutes of arrival triggers an automatic quarantine hold and a notification to the originating shipper.

The event stream underlying the system uses an append-only log with monotonically increasing sequence numbers per shipment. Consumers are expected to be idempotent because the delivery guarantee is at-least-once. A reconciliation job runs every six hours and compares the materialized state in each tier's ledger against the canonical event log. Discrepancies are classified into three severity bands. Band A discrepancies, such as a shipment marked delivered in the ledger but still in transit in the log, freeze the affected shipment record and page the regional duty officer. Band B discrepancies, such as timestamp drift beyond five minutes, are queued for the nightly batch repair. Band C discrepancies, mostly cosmetic field mismatches, are logged and ignored. During the first year of operation roughly ninety-four percent of all discrepancies fell into Band C, which the engineering retrospective attributed to inconsistent timezone handling in legacy adapters rather than genuine state divergence.

Capacity planning in the Continental Spine relies on a forecasting model trained on seven years of seasonal shipment data. The model produces corridor-level demand estimates at weekly granularity, which planners convert into equipment positioning orders. A persistent criticism from regional managers is that the model underweights agricultural surge periods in the southern districts, where harvest timing varies by up to three weeks year over year. To compensate, the consortium allows regional managers to file surge overrides, which reserve up to fifteen percent of corridor capacity ahead of the forecast. Overrides expire after fourteen days unless renewed, and unused override capacity is released back to the general pool at midnight on the expiry date. An audit in the third operating year found that override utilization averaged only forty-one percent, prompting a policy change that now requires a written justification for renewals beyond two consecutive periods.

The Local Loop tier is the most heterogeneous part of the system because it absorbed eleven different municipal courier networks during the consolidation. Rather than forcing a single dispatch algorithm, the Local Loop exposes a plugin interface with three mandatory operations: accept manifest, propose route, and confirm completion. Municipal operators may implement routing however they wish, provided the proposed routes satisfy consortium-wide constraints on driver hours, vehicle emissions zones, and hazardous material separation. Compliance is verified by a constraint checker that runs before any route is activated. The checker is intentionally conservative: when it cannot prove a constraint is satisfied, it rejects the route and attaches a machine-readable explanation. Operators initially complained about rejection rates near twelve percent, but after the explanation format was standardized, most operators built automatic repair loops that resubmit corrected routes, bringing effective rejection rates below two percent.

Security and access control follow a capability model rather than role hierarchies. Every actor, human or service, holds a set of scoped capability tokens issued by the consortium identity service. A token grants a specific verb on a specific resource class within a specific tier, such as reading temperature logs in the Regional Mesh or amending manifests in the Local Loop. Tokens are short-lived and renewed automatically while the holder remains in good standing. The design goal was to make cross-tier privilege escalation structurally impossible: no single token is valid in more than one tier, and the issuing service refuses to mint compound tokens. During a red-team exercise in the fifth operating year, the assessors managed to replay an expired token against a misconfigured depot gateway, which led to the introduction of mandatory token binding to transport-layer session identifiers.

Financial settlement between the consortium and its member carriers happens monthly through a clearing process that consumes the same event stream as the operational tiers. Each completed shipment generates a settlement record containing the negotiated rate, fuel adjustment, and any penalty deductions for missed service windows. Disputes must be filed within twenty-one days of statement issuance and are adjudicated by a standing committee whose composition rotates quarterly. The most common dispute category concerns penalty deductions for delays caused by mandatory cold-chain inspection stops, which carriers argue should be excluded from service window calculations. A charter amendment proposed in the sixth operating year would exclude certified inspection dwell time from delay penalties, but it has not yet been ratified, and until ratification the clearing process continues to count inspection dwell time against carriers.

Question: According to the document above, which tier of the Meridian system handles cold-chain freight, and what happens if a thermal custodian does not sign the temperature log within ninety minutes of arrival? Answer in two sentences.`;

export const PROMPTS: readonly BenchPrompt[] = [
  { id: "short", text: SHORT_PROMPT, maxTokens: 128 },
  { id: "long-context", text: LONG_DOCUMENT, maxTokens: 128 },
];

/** Untimed warmups excluded, then 3 timed generations (Section 4). */
export const TIMED_RUNS = 3;
export const WARMUP_RUNS = 1;
