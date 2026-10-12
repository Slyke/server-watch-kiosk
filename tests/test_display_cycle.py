#!/usr/bin/env python3
"""Safety and timing regressions for the unattended display controller."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'display_cycle', Path(__file__).parents[1] / 'deploy/omarchy/display-cycle.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def status(**overrides):
    return dict(locked=False, secure=False, kioskIdle=False, lastWakeAt=0,
                authenticating=False) | overrides


class DisplayCycleTests(unittest.TestCase):
    def setUp(self):
        self.cycle = module.DisplayCycle(1800, 300)

    def test_activity_delays_lock_without_a_wall_clock_deadline(self):
        self.assertIsNone(self.cycle.step(status(), 7200))
        self.assertEqual(self.cycle.step(status(kioskIdle=True), 7300), 'lock')

    def test_never_blanks_before_compositor_confirms_security(self):
        self.assertEqual(self.cycle.step(status(kioskIdle=True), 1800), 'lock')
        self.assertIsNone(self.cycle.step(status(locked=True), 1802))
        self.assertEqual(self.cycle.step(status(locked=True, secure=True), 1804), 'off')

    def test_five_minute_rest_then_thirty_minute_visible_lock(self):
        s = status(locked=True, secure=True)
        self.assertEqual(self.cycle.step(s, 0), 'off')
        self.assertIsNone(self.cycle.step(s, 299))
        self.assertEqual(self.cycle.step(s, 300), 'on')
        self.assertIsNone(self.cycle.step(s, 2099))
        self.assertEqual(self.cycle.step(s, 2100), 'off')
        self.assertTrue(s['locked'])

    def test_input_wakes_display_without_unlocking(self):
        s = status(locked=True, secure=True)
        self.cycle.step(s, 0)
        self.assertEqual(self.cycle.step(s | {'lastWakeAt': 1000}, 5), 'on')
        self.assertTrue(s['locked'])

    def test_password_unlock_cancels_rest_and_rearms_inactivity(self):
        self.cycle.step(status(locked=True, secure=True), 0)
        self.assertEqual(self.cycle.step(status(), 10), 'on')
        self.assertIsNone(self.cycle.step(status(), 4000))
        self.assertEqual(self.cycle.step(status(kioskIdle=True), 5000), 'lock')

    def test_does_not_blank_during_password_verification(self):
        s = status(locked=True, secure=True)
        self.cycle.step(s, 0)
        self.cycle.step(s, 300)
        self.assertIsNone(self.cycle.step(s | {'authenticating': True}, 2100))
        self.assertEqual(self.cycle.step(s, 2102), 'off')


if __name__ == '__main__':
    unittest.main()
