"""Offline destination checks; no browser launch or game/Stripe traffic."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import milkyway_autopay as app


GAME = "https://test.milkywayidle.com/game?characterId=12345"
CHECKOUT = "https://checkout.stripe.com/c/pay/cs_test_fixture"


class URLValidationTests(unittest.TestCase):
    def test_both_test_game_hosts_are_allowed(self):
        for host in app.TEST_GAME_HOSTS:
            app.require_test_game_url(f"https://{host}/game?characterId=12345")

    def test_production_lookalike_insecure_and_credentialed_game_urls_are_rejected(self):
        for url in ("https://www.milkywayidle.com/game", "https://milkywayidle.com/game",
                    "https://test.milkywayidle.com.evil.invalid/game",
                    "https://evil.invalid/?next=https://test.milkywayidle.com/game",
                    "http://test.milkywayidle.com/game", "https://test.milkywayidle.com:444/game",
                    "https://user@test.milkywayidle.com/game", ""):
            with self.subTest(url=url), self.assertRaises(ValueError):
                app.require_test_game_url(url)

    def test_official_test_checkout_path_forms_are_allowed(self):
        for url in (CHECKOUT, "https://checkout.stripe.com/pay/cs_test_fixture#opaque"):
            app.require_test_checkout_url(url)

    def test_production_lookalike_and_missing_checkout_sessions_are_rejected(self):
        for url in ("https://checkout.stripe.com/c/pay/cs_live_fixture",
                    "https://checkout.stripe.com/c/pay/", "https://checkout.stripe.com/",
                    "https://checkout.stripe.com/?session=cs_test_fixture",
                    "https://checkout.stripe.com.evil.invalid/c/pay/cs_test_fixture",
                    "https://user@checkout.stripe.com/c/pay/cs_test_fixture",
                    "http://checkout.stripe.com/c/pay/cs_test_fixture", ""):
            with self.subTest(url=url), self.assertRaises(ValueError):
                app.require_test_checkout_url(url)

    def test_placeholder_example_loads_without_any_authentication_files(self):
        root = Path(__file__).resolve().parent
        accounts = app.load_accounts(root / 'accounts.example.json')
        self.assertEqual(len(accounts), 2)
        self.assertTrue(all('YOUR_CHARACTER_ID_' in account.game_url for account in accounts))
        self.assertTrue(all(not (root / account.state_file).exists() for account in accounts))
        args = app.build_parser().parse_args(['run', '--accounts', 'accounts.json', '--loops', '1', '--quantity', '99'])
        self.assertEqual((args.loops, args.quantity), (1, 99))


class EntryPointSafetyTests(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_account_config_is_rejected_before_playwright(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'accounts.json'
            path.write_text(json.dumps([{'name': 'fixture', 'game_url': 'https://milkywayidle.com/game',
                                         'state_file': 'unused.json'}]))
            with patch.object(app, 'async_playwright', side_effect=AssertionError('must not start')):
                with self.assertRaises(ValueError):
                    app.load_accounts(path)
                with self.assertRaises(ValueError):
                    await app.run_parallel([app.AccountConfig('fixture', 'https://milkywayidle.com/game',
                                                               'unused.json')], app.RunSettings())

    async def test_direct_context_and_worker_entries_validate_before_browser_work(self):
        account = app.AccountConfig('fixture', 'https://milkywayidle.com/game', 'unused.json')
        browser = SimpleNamespace(new_context=AsyncMock())
        playwright = SimpleNamespace(chromium=SimpleNamespace(launch=AsyncMock()))
        with self.assertRaises(ValueError):
            await app.new_context_for_account(browser, account, app.RunSettings())
        with self.assertRaises(ValueError):
            await app.account_worker(playwright, account, app.RunSettings(), None)
        browser.new_context.assert_not_awaited()
        playwright.chromium.launch.assert_not_awaited()

    async def test_actual_game_page_is_checked_before_store_interactions(self):
        with self.assertRaises(ValueError):
            await app.open_100_dollar_package(SimpleNamespace(url='https://milkywayidle.com/game'),
                                              package_timeout_sec=1)

    async def test_captured_live_url_and_redirected_live_page_are_rejected(self):
        for redirect in (False, True):
            control = SimpleNamespace(wait_for=AsyncMock(), click=AsyncMock())
            game = SimpleNamespace(url=GAME, context=object(),
                get_by_role=lambda *a, **kw: SimpleNamespace(first=control),
                get_by_text=lambda *a, **kw: SimpleNamespace(first=control))
            checkout = SimpleNamespace(url=CHECKOUT)
            async def navigate(*args, **kwargs):
                checkout.url = CHECKOUT.replace('cs_test_', 'cs_live_')
            checkout.goto = AsyncMock(side_effect=navigate)
            captured = CHECKOUT if redirect else CHECKOUT.replace('cs_test_', 'cs_live_')
            with self.subTest(redirect=redirect), \
                 patch.object(app, 'enter_store_and_get_region', new=AsyncMock(return_value=object())), \
                 patch.object(app, 'wait_for_100_package_in_region', new=AsyncMock(return_value=object())), \
                 patch.object(app, 'maybe_click_with_intercept_retry', new=AsyncMock()), \
                 patch.object(app, 'install_window_open_capture', new=AsyncMock()), \
                 patch.object(app, 'wait_for_checkout_url', new=AsyncMock(return_value=captured)), \
                 patch.object(app, 'new_checkout_worker_tab', new=AsyncMock(return_value=checkout)) as new_tab:
                with self.assertRaisesRegex(RuntimeError, 'cs_test_'):
                    await app.open_100_dollar_package(game, package_timeout_sec=1, max_attempts=1)
            if redirect:
                new_tab.assert_awaited_once()
                checkout.goto.assert_awaited_once()
            else:
                new_tab.assert_not_awaited()
                checkout.goto.assert_not_awaited()

    async def test_invalid_actual_checkout_page_cannot_resolve_fields_or_submit(self):
        page = SimpleNamespace(url=CHECKOUT.replace('cs_test_', 'cs_live_'))
        with patch.object(app, 'resolve_manual_fields_fast', new=AsyncMock()) as resolve:
            with self.assertRaises(ValueError):
                await app.submit_checkout_only_fast(page)
        resolve.assert_not_awaited()

    async def test_page_redirect_during_form_filling_is_rechecked_before_click(self):
        page = SimpleNamespace(url=CHECKOUT, wait_for_timeout=AsyncMock())
        fields = SimpleNamespace(submit=SimpleNamespace(click=AsyncMock()))
        async def redirect(_):
            page.url = CHECKOUT.replace('cs_test_', 'cs_live_')
        with patch.object(app, 'resolve_manual_fields_fast', new=AsyncMock(return_value=fields)), \
             patch.object(app, 'fill_manual_fields_fast', new=AsyncMock(side_effect=redirect)):
            with self.assertRaises(ValueError):
                await app.submit_checkout_only_fast(page)
        fields.submit.click.assert_not_awaited()

    async def test_valid_test_checkout_submits_once_with_original_test_card(self):
        page = SimpleNamespace(url=CHECKOUT, wait_for_timeout=AsyncMock())
        fields = SimpleNamespace(submit=SimpleNamespace(click=AsyncMock()))
        with patch.object(app, 'resolve_manual_fields_fast', new=AsyncMock(return_value=fields)), \
             patch.object(app, 'fill_manual_fields_fast', new=AsyncMock()) as fill:
            result = await app.submit_checkout_only_fast(page)
        fill.assert_awaited_once_with(fields)
        fields.submit.click.assert_awaited_once()
        self.assertIs(result.page, page)
        self.assertEqual(app.TEST_CARD, '4242424242424242')

    async def test_remote_cdp_is_rejected_before_connecting(self):
        with patch.object(app, 'async_playwright', side_effect=AssertionError('must not start')):
            with self.assertRaises(ValueError):
                await app.save_state_from_existing_chrome('http://remote.invalid:9222', 'unused.json')

    async def test_save_state_selects_unique_test_context_without_exporting_first_context(self):
        production = SimpleNamespace(pages=[SimpleNamespace(url='https://milkywayidle.com/game')],
                                     storage_state=AsyncMock())
        test = SimpleNamespace(pages=[SimpleNamespace(url=GAME)], storage_state=AsyncMock())
        browser = SimpleNamespace(contexts=[production, test])
        runtime = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=AsyncMock(return_value=browser)),
                                  stop=AsyncMock())
        with patch.object(app, 'async_playwright', return_value=SimpleNamespace(start=AsyncMock(return_value=runtime))):
            await app.save_state_from_existing_chrome('http://127.0.0.1:9222', 'unused.json')
        production.storage_state.assert_not_awaited()
        test.storage_state.assert_awaited_once_with(path='unused.json', indexed_db=True)
        runtime.stop.assert_awaited_once()

    async def test_save_state_refuses_missing_or_ambiguous_test_contexts(self):
        for count in (0, 2):
            contexts = [SimpleNamespace(pages=[SimpleNamespace(url=GAME)], storage_state=AsyncMock())
                        for _ in range(count)]
            runtime = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=AsyncMock(
                return_value=SimpleNamespace(contexts=contexts))), stop=AsyncMock())
            with self.subTest(count=count), patch.object(app, 'async_playwright',
                    return_value=SimpleNamespace(start=AsyncMock(return_value=runtime))):
                with self.assertRaises(RuntimeError):
                    await app.save_state_from_existing_chrome('http://localhost:9222', 'unused.json')
            self.assertTrue(all(not context.storage_state.await_count for context in contexts))
            runtime.stop.assert_awaited_once()


if __name__ == '__main__':
    unittest.main()
