# Changes from the historical snapshot

Base: `ZhonghuaM/milkyway-autopay`, commit `bc77aaf262c0f8bd6b5999e8adaf08487022a9cb`.

- Validate account and actual game-page URLs against the two HTTPS test hosts before game interactions.
- Validate captured Stripe URLs and the actual page again immediately before the submit click. Only the exact HTTPS checkout host and `/c/pay/cs_test_…` or `/pay/cs_test_…` paths are accepted.
- Keep the original fixed test card. No production credential or current integrated-runner code is added.
- Limit `save-state` to a loopback debugging endpoint and the unique context containing a test-server game page. It exports local browser state; it does not submit a payment. A dedicated profile is still necessary because the context's full storage is exported.
- Replace numeric example character IDs with explicit placeholders and ignore local JSON state by default, except the supplied example.
- Omit the exploratory notebook and old Git history. Rebuild the README and add offline safety tests.

Queueing, browser recycling, quantity controls, payment UI behavior, and result accounting otherwise retain the old implementation. These checks are destination guards, not a claim of service authorization or current end-to-end compatibility. No live purchase or login was performed to prepare this snapshot.
