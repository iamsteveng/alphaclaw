#!/usr/bin/env python3
"""Unit tests for the basing-watch streak engine.

Run: python3 -m unittest lib/setup/skills/basing-watch/test_basing_watch.py -v
(or from this directory: python3 -m unittest test_basing_watch -v)
"""
import unittest

from basing_watch import compute_watch


def series(*closes, start="2026-06-01"):
    """Build an ascending close series from bare floats with synthetic dates."""
    import datetime

    d = datetime.date.fromisoformat(start)
    out = []
    for c in closes:
        while d.weekday() >= 5:
            d += datetime.timedelta(days=1)
        out.append({"date": d.isoformat(), "close": float(c)})
        d += datetime.timedelta(days=1)
    return out


def drift(start_price, pct_changes, **kw):
    """Series from a start price and a list of daily % changes."""
    closes = [start_price]
    for p in pct_changes:
        closes.append(closes[-1] * (1 + p / 100.0))
    return series(*closes, **kw)


class TestStreakEngine(unittest.TestCase):
    def test_flat_series_is_base_confirmed(self):
        # 15 closes, ±0.5% wiggle: 14 qualifying days
        r = compute_watch(drift(100, [0.5, -0.5] * 7))
        self.assertEqual(r["streak"], 14)
        self.assertEqual(r["state"], "base-confirmed")
        self.assertIsNone(r["last_reset"])

    def test_big_down_day_resets_to_zero(self):
        r = compute_watch(drift(100, [0.2] * 12 + [-4.0]))
        self.assertEqual(r["streak"], 0)
        self.assertEqual(r["state"], "downtrending")
        self.assertEqual(r["last_reset"]["reason"], "big-down-day")

    def test_exactly_minus_three_percent_is_big_down_day(self):
        r = compute_watch(drift(100, [0.1] * 6 + [-3.0]))
        self.assertEqual(r["streak"], 0)
        self.assertEqual(r["last_reset"]["reason"], "big-down-day")

    def test_slow_bleed_resets_via_band_breach(self):
        # -1.2%/day: no single big down day, but the band catches the bleed.
        r = compute_watch(drift(100, [-1.2] * 15))
        self.assertLess(r["streak"], 5)
        self.assertEqual(r["state"], "downtrending")
        self.assertEqual(r["last_reset"]["reason"], "band-breach")

    def test_upward_rip_out_of_band_resets(self):
        r = compute_watch(drift(100, [0.1] * 8 + [6.0]))
        self.assertEqual(r["streak"], 0)
        self.assertEqual(r["last_reset"]["reason"], "band-breach")

    def test_reset_reanchors_band_to_reset_day_close(self):
        # Crash to ~87, then flat: streak rebuilds against the new anchor.
        r = compute_watch(drift(100, [0.2, -13.0] + [0.3, -0.3] * 4))
        self.assertEqual(r["streak"], 8)
        self.assertEqual(r["state"], "stabilizing")
        self.assertAlmostEqual(r["anchor"]["close"], 100 * 1.002 * 0.87, places=4)

    def test_stabilizing_at_five_downtrending_at_four(self):
        base = [0.2] * 3 + [-4.0]  # reset partway through
        self.assertEqual(compute_watch(drift(100, base + [0.1] * 5))["state"], "stabilizing")
        self.assertEqual(compute_watch(drift(100, base + [0.1] * 4))["state"], "downtrending")

    def test_base_confirmed_at_ten(self):
        base = [0.2] * 3 + [-4.0]
        r = compute_watch(drift(100, base + [0.1] * 10))
        self.assertEqual(r["streak"], 10)
        self.assertEqual(r["state"], "base-confirmed")

    def test_band_edges_and_distance(self):
        r = compute_watch(drift(100, [0.0] * 6))
        self.assertAlmostEqual(r["band"]["low"], 95.0)
        self.assertAlmostEqual(r["band"]["high"], 105.0)
        # at the anchor price, 5% of headroom both ways
        self.assertAlmostEqual(r["distance"]["to_band_low_pct"], 5.0)
        self.assertAlmostEqual(r["distance"]["to_band_high_pct"], 5.0)

    def test_big_down_day_takes_priority_over_band_breach(self):
        # -8% both breaches the band and is a big down day → big-down-day wins
        r = compute_watch(drift(100, [0.1] * 5 + [-8.0]))
        self.assertEqual(r["last_reset"]["reason"], "big-down-day")

    def test_latest_fields(self):
        rows = drift(100, [0.5] * 5)
        r = compute_watch(rows)
        self.assertEqual(r["latest"]["date"], rows[-1]["date"])
        self.assertAlmostEqual(r["latest"]["close"], rows[-1]["close"])
        self.assertAlmostEqual(r["latest"]["pct_change"], 0.5, places=6)

    def test_requires_at_least_two_closes(self):
        with self.assertRaises(ValueError):
            compute_watch(series(100))


if __name__ == "__main__":
    unittest.main()
