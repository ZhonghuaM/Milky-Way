# Public versions and validation scope

Release preparation date: 2026-11-13. Each feature branch was created from a specific historical snapshot. Working directories, personal runtime data and earlier Git histories were not migrated.

| Component | Source | Validation for this release |
| --- | --- | --- |
| Standalone userscripts | Frozen enhancer 1.6.10, market 1.3.3 and Task 1.10.1 files | Six offline test suites passed; Task 196/196; coexistence covered six loading orders |
| Standalone labyrinth tool | Original repository at `61e8c1f654479726325f5c7b8f72ca2670f24c70` | 11 offline unit tests passed; no browser run was performed for this release |
| Historical Cowbell test tool | Original repository at `bc77aaf262c0f8bd6b5999e8adaf08487022a9cb` | 15 offline safeguard tests, CLI syntax checks and placeholder-example checks passed; no game or checkout-service connections |
| Experience attribute stacking | Anonymised summary of private experiment records dated 2026-11-12 | Readings cross-checked for three individual probes and the two-probe and three-probe combinations |
| Actual skill-experience observation | Anonymised summary of a short experience record dated 2026-11-12 | Duration and category totals checked; no controlled comparison or room-level attribution |

A passing test applies only to the component and checks listed above. Offline validation of historical scripts does not establish that the current integrated system can be reproduced, nor does it guarantee compatibility with future game updates. Attribute stacking does not establish an increase in experience actually earned.

## Publication scope

Public materials include historical standalone tools, relevant offline tests, placeholder configurations, diagrams and anonymised summaries. The current integrated system's implementation, strategy parameters and internal test code are outside the publication scope.

Real account data, login state, runtime logs, transaction details, raw experiment snapshots and local machine paths are excluded. The historical notebook is not included as a Cowbell branch entry point because its examples have sequential-execution issues.

## Checking the published versions

- The userscript branch's `release-manifest.json` lists SHA-256 hashes for the three frozen source files.
- The labyrinth branch adds provenance links to the README while retaining the historical implementation.
- The Cowbell branch documents its historical source and additional test-environment checks. It does not use the current integrated implementation.
- Summaries and figures report only the available evidence. Comparisons of actual returns across complete time windows remain to be tested.
