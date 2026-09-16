# Supply express tracking setup

The optional Kuaidi100 adapter follows the [official realtime query API](https://api.kuaidi100.com/document/5f0ffb5ebc8da837cbd8aefc). No requests are sent while disabled.

On both the API and worker, configure `LOGISTICS_PROVIDER=kuaidi100`, `KUAIDI100_CUSTOMER` and `KUAIDI100_KEY` from the purchased account using deployment secrets. Do not commit credentials. Restart both services after configuration. A real provider account is required; the automated tests use a controlled local response and do not prove that a live account is enabled.

The worker claims due shipments in PostgreSQL and queries each pending parcel no more than hourly. Only the courier code, tracking number and order recipient phone are sent to the HTTPS provider. No certificate images or bank details are transmitted. The carrier and parcel number in the result must match the shipment. Base state `3` plus valid trace data completes an order; delivery-looking free text, failed requests, exceptions and returns do not.

Requests time out at 15 seconds. The database stores the next attempt before querying, so restart/crash failures retry after an hour. Signed parcels stop polling. Shipments corrected during an outstanding query invalidate its token, preventing an old parcel result from completing the new shipment. API and worker must share the database and provider configuration.

Migration `010_supply_orders.sql` is additive and must run before the new API starts. The new internal permission is seeded only to ADMIN, SUPER_ADMIN and SUPPLY_MANAGER. Supplier fulfillment uses the supplier's existing portal permission plus account ownership checks.
