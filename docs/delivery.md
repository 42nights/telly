# Food delivery (simulated)

Issue #43. When the wearer cannot prepare a meal, a family member proposes a delivery order. The
only provider is a simulator in `apps/server/src/integrations/delivery.ts`. It keeps orders in
memory, calls no network service, and charges nothing. Every menu, proposal, and order response
carries `provider.simulated: true`. No code in this repository places a real order.

## Flow

All routes are under `/api/families/:familyId/delivery`, behind sign-in and the family check.
The contract is `@health/contracts/delivery`.

1. `GET menu`: the simulated menu, with allergens and "suitable for" tags.
2. `POST proposals`: the family member confirms the address, the recipient who will be there,
   allergies, dietary needs, help needed at the door, the delivery window, and a budget. The server
   prices the items and refuses the proposal (400) when an item contains a confirmed allergen,
   lacks a dietary tag, or the total with fees, tax, and tip is over the budget.
3. `POST proposals/:id/approval` with `{ "purchase": true, "totalCents": … }`: the explicit
   purchase confirmation. The total must equal the proposal total. There is no standing
   authorization.
4. `POST proposals/:id/substitutions` with `{ "replace", "with" }`: makes a new proposal with the
   same requirements. The same checks apply, and the new proposal needs its own approval. The old
   proposal becomes `replaced` and can never be ordered.
5. `POST proposals/:id/order`: places the approved order. The proposal id is the provider's
   idempotency key, and the provider refuses any price other than the approved total.
   - No reply in 10 s, or an error: the order is `uncertain`, because it may exist.
   - A retry of an `uncertain` order asks the provider about the order id first. If the order
     exists, the status becomes `placed` and nothing is bought again. If not, the retry places it
     with the same id.
   - A refusal, such as a sold-out item, makes it `failed`. The provider never substitutes an
     item without a new proposal and approval.
6. `POST proposals/:id/refresh`: asks the provider for the status. `delivered` does not mean that
   the wearer ate.
7. `POST proposals/:id/eaten`: a person reports that the wearer ate.

The statuses are stored append-only in the `delivery_event` table. The module accepts each status
only after the statuses that it may follow.

## Real providers

No real provider is connected, and none is approved. Each one needs an account, terms, and payment
setup that this project does not have. As of 2026-10-04, from the public documentation:

- [DoorDash Drive](https://developer.doordash.com/en-US/api/drive/) sends a courier from a
  business's pickup address. It does not order restaurant menu items for a consumer, and it needs a
  DoorDash developer and business account.
- [Instacart Developer Platform](https://docs.instacart.com/developer_platform_api/api/products/create_shopping_list_page)
  makes a shopping list page. The user checks out on Instacart, so the API cannot buy for the
  wearer.
- Uber Direct is also a courier service for businesses, with a business account.

A real integration must keep the approval, the idempotency key, and the order check before a retry.
