# Procurement Sourcing Intelligence

A procurement project turns explicit demand into source-grounded public supplier and product leads. Shared public intelligence is reusable evidence, while project-specific assessment is never inherited from another project.

## Public intelligence

**Supplier**:
A public organization observed in a source; identity remains `DISCOVERED_UNVERIFIED` until independent identity evidence is available. Different websites with the same display name remain separate observations.
_Avoid_: Qualified supplier, approved supplier

**Product**:
A publicly described product or exact model observed in a source. A product model is not a claim that it meets a project's requirements.
_Avoid_: Qualified product, compliant product

**Offering**:
An evidence-backed observation that a supplier appears to offer a product. It does not establish authorization, current availability, capacity, or a future supply commitment.
_Avoid_: Supplier contract, confirmed supply

**Supplier Intelligence**:
Workspace-scoped reusable public supplier, product, offering, claim, and evidence records. Reuse makes a lead available for review; it does not transfer qualification or project decisions.
_Avoid_: Supplier master approval, historical supplier

**Project Candidate**:
A project- and requirement-specific lead linking a supplier/product to newly collected or reused evidence. M2 creates only `DISCOVERED_LONG_LIST`; later technical/commercial assessment belongs to later milestones.
_Avoid_: Shortlist, winner

## Evidence and decisions

**Evidence**:
A timestamped snapshot of public source content with URL, content hash, locator, excerpt, and provenance. A search snippet is only a discovery hint and is not evidence.
_Avoid_: Search result, citation-only string

**Claim**:
A source-attributed statement about a supplier or product, linked to exact evidence and a verbatim quote. `SUPPORTED_BY_SOURCE` means the source states it, not independent verification.
_Avoid_: Verified fact, guarantee

**Research Finding**:
A bounded task's structured supplier/product leads, evidence IDs, source-backed claim proposals, unresolved gaps, and measured search/fetch use. It is not a final procurement recommendation.
_Avoid_: Research report, sourcing decision

**Sourcing Plan**:
A revisioned, provenance-aware strategy containing the research goal, target market only when supported, questions, channels, shared budgets, reuse/refresh decisions, and stopping conditions.
_Avoid_: Fixed query list
