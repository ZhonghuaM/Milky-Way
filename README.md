# Historical standalone Cowbell / autopay

Source snapshot: [`ZhonghuaM/milkyway-autopay` at `bc77aaf262c0f8bd6b5999e8adaf08487022a9cb`](https://github.com/ZhonghuaM/milkyway-autopay/tree/bc77aaf262c0f8bd6b5999e8adaf08487022a9cb), published 29 March 2026. This branch preserves that standalone Playwright program with the small, documented [safety changes](SAFETY_CHANGES.md). It contains no current integrated Python/Node runner or private account state.

[Return to the Milky-Way project overview](https://github.com/ZhonghuaM/Milky-Way/tree/main).

The script opens the game's checkout page, selects the requested quantity, fills the fixed test card, and submits through the browser. It requires authenticated browser state that you create locally. Its original UI-based completion detection and recovery behavior are retained; a submitted checkout is not proof of an exact game-inventory credit.

## Install

Use Python 3.10 or later in a dedicated environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 -m playwright install chromium
cp accounts.example.json accounts.json
```

Edit `accounts.json` with your own test-server character IDs and local storage-state paths. The example uses explicit placeholders; no account or login session is supplied. Only `https://test.milkywayidle.com/game` and `https://test.milkywayidlecn.com/game` are accepted.

## Save your local test login

Start a dedicated Chrome profile with a loopback debugging endpoint, sign in to the test game, and export its state:

```bash
python3 milkyway_autopay.py save-state \
  --cdp-url http://127.0.0.1:9222 \
  --output mwidle_state_example_1.json
```

There must be exactly one browser context containing a test-server game page. The export includes that context's complete browser storage, so use a dedicated test profile without unrelated logins. Keep the debugging endpoint and exported JSON private. Close the signed-in game tab before starting the headless runner for the same character.

## Run a bounded test

```bash
python3 milkyway_autopay.py run --accounts accounts.json --loops 1 --quantity 99
```

The program checks test-server game URLs before browser startup/navigation. Captured checkout URLs and the actual checkout page immediately before submission must use HTTPS, the exact `checkout.stripe.com` host, and a `cs_test_` session path. Production sessions, lookalike hosts, and missing session IDs are rejected. The original fixed test card is unchanged.

This is a historical implementation. It has not been verified against the current live test service as part of this publication. The package includes no login data, diagnostic outputs, notebook execution history, or Git history.

## Offline validation

```bash
python3 -m unittest test_safety -v
python3 milkyway_autopay.py --help
```

The tests use synthetic pages and browser mocks. They do not open a browser, connect to a game, or contact Stripe.

## Files and terms

The release contains the standalone CLI, placeholder account configuration, dependencies, ignore rules, documentation, and offline safety tests. The historical exploratory notebook is excluded.

The original [additional terms](LICENSE-ADDITIONAL-TERMS.md) are preserved. The source snapshot did not include a separate main license despite referring to one in those terms; this branch does not claim a new blanket MIT license. Other feature branches have their own provenance and notices.
