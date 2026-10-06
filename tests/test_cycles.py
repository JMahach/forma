"""Exact return roots, winding ownership and reference cases."""
import pathlib
import hashlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from server.python import cycles, astronomy as astro
from server.python.errors import ChartError

BIRTH = '2000-01-01T00:00:00Z'


class CrossingTests(unittest.TestCase):
    def test_wrap_does_not_add_antipodal_false_return(self):
        roots = cycles.scan_crossings(lambda t: ((350 + 50 * t) % 360, 50), 0, 8, 1)
        self.assertEqual(len(roots), 1)
        self.assertAlmostEqual(roots[0]['jd'], 7.2)
        self.assertEqual(roots[0]['cycle'], 1)

    def test_three_retrograde_passages_keep_one_cycle(self):
        def sample(t):
            return (360 + 6 * (t - 3) * (t - 4) * (t - 5)) % 360, 18 * t * t - 144 * t + 282
        roots = cycles.scan_crossings(sample, 0, 6, 1)
        self.assertEqual([round(item['jd'], 8) for item in roots], [3, 4, 5])
        self.assertEqual([item['cycle'] for item in roots], [1, 1, 1])
        self.assertEqual([item['direction'] for item in roots], ['direct', 'retrograde', 'direct'])

    def test_birth_near_repeats_do_not_become_age_cycles(self):
        def sample(t):
            return (60 * t * (t - 1) * (t - 2)) % 360, 60 * (3 * t * t - 6 * t + 2)
        roots = cycles.scan_crossings(sample, 0, 3.1, 0.2)
        self.assertEqual(len(roots), 1)
        self.assertAlmostEqual(roots[0]['jd'], 3)
        self.assertEqual(roots[0]['cycle'], 1)

    def test_station_tangent_and_close_paired_roots_are_not_missed(self):
        tangent = cycles.scan_crossings(lambda t: ((360 * (2 * t - t * t)) % 360, 720 * (1 - t)), 0, 2, 0.3)
        self.assertEqual(len(tangent), 1)
        self.assertAlmostEqual(tangent[0]['jd'], 1)
        self.assertEqual(tangent[0]['direction'], 'stationary')
        pair = cycles.scan_crossings(lambda t: ((361 * (2 * t - t * t)) % 360, 722 * (1 - t)), 0, 2, 0.3)
        self.assertEqual(len(pair), 2)
        self.assertLess(pair[0]['jd'], 1)
        self.assertGreater(pair[1]['jd'], 1)
        self.assertEqual([item['cycle'] for item in pair], [1, 1])

    def test_regressive_nodes_and_oppositions_have_separate_turn_rules(self):
        nodes = cycles.scan_crossings(lambda t: ((3 - 40 * t) % 360, -40), 0, 10, 1, direction=-1)
        self.assertEqual([(item['jd'], item['cycle']) for item in nodes], [(9, 1)])
        opposition = cycles.scan_crossings(lambda t: ((350 + 50 * t) % 360, 50), 0, 12, 1, offset=180)
        self.assertEqual([round(item['jd'], 8) for item in opposition], [3.6, 10.8])
        self.assertEqual([item['cycle'] for item in opposition], [1, 2])


class ReturnEngineTests(unittest.TestCase):
    def test_reference_saturn_all_passes_and_narrow_window_keep_pass_number(self):
        result = cycles.events(dict(birthUtc=BIRTH, body='saturn', fromAge=28, toAge=30))
        expected = ['2028-07-21T12:36:05.921Z', '2028-09-24T13:49:26.494Z', '2029-04-01T23:24:11.691Z']
        self.assertEqual(len(result['events']), 3)
        for event, reference in zip(result['events'], expected):
            self.assertLess(abs((cycles.parse_utc(event['utc']) - cycles.parse_utc(reference)).total_seconds()), 0.01)
            self.assertEqual(event['cycle'], 1)
            self.assertEqual(event['cycleId'], 'saturn:1')
        self.assertEqual([event['pass'] for event in result['events']], [1, 2, 3])
        self.assertEqual([event['direction'] for event in result['events']], ['direct', 'retrograde', 'direct'])
        narrower = cycles.events(dict(birthUtc=BIRTH, body='saturn', fromAge=29, toAge=30))
        self.assertEqual(narrower['events'][0]['pass'], 3)

    def test_solar_and_uranus_opposition_reference(self):
        sun = cycles.events(dict(birthUtc=BIRTH, body='sun', fromAge=26.5, toAge=27.5))['events'][0]
        self.assertLess(abs((cycles.parse_utc(sun['utc']) - cycles.parse_utc('2026-12-31T13:08:30.937Z')).total_seconds()), 0.01)
        self.assertEqual((sun['cycle'], sun['pass']), (27, 1))
        uranus = cycles.events(dict(birthUtc=BIRTH, body='uranus_opposition', fromAge=42, toAge=44))['events']
        self.assertEqual(len(uranus), 3)
        self.assertLess(abs((cycles.parse_utc(uranus[0]['utc']) - cycles.parse_utc('2042-09-02T20:09:22.351Z')).total_seconds()), 0.01)
        self.assertEqual([item['pass'] for item in uranus], [1, 2, 3])

    def test_exact_chart_preserves_seconds_and_88_degree_design(self):
        result = cycles.chart(dict(birthUtc=BIRTH, body='saturn', eventUtc='2028-07-21T12:36:05.921Z', timezone='Europe/London'))
        chart = result['chart']
        self.assertEqual(chart['source'], 'calculated')
        self.assertEqual(chart['birthTime'], '13:36')
        self.assertEqual(chart['utcOffset'], 'UTC+01:00')
        self.assertEqual(chart['utc'], result['event']['utc'])
        self.assertLess(abs((cycles.parse_utc(chart['designUtc']) - cycles.parse_utc('2028-04-20T20:24:56.033Z')).total_seconds()), 0.01)
        for side in ('personality', 'design'):
            self.assertEqual(len(chart['activations'][side]), 13)
            jd = astro.julian_tt(cycles.parse_utc(chart['utc' if side == 'personality' else 'designUtc']))
            self.assertEqual(chart['activations'][side], astro.activations(jd))
        self.assertLess(chart['designArcResidualDegrees'], 1e-7)
        with self.assertRaises(ChartError) as failure:
            cycles.chart(dict(birthUtc=BIRTH, body='saturn', eventUtc='2028-07-21T12:36:00Z', timezone='UTC'))
        self.assertEqual(failure.exception.payload['error'], 'invalid_event')

    def test_all_supported_bodies_keep_angles_exact(self):
        for body in cycles.BODIES:
            with self.subTest(body=body):
                result = cycles.events(dict(birthUtc=BIRTH, body=body, fromAge=0, toAge=100))
                natal = cycles.position(astro.julian_tt(cycles.parse_utc(BIRTH)), body)[0]
                for event in result['events']:
                    actual = cycles.position(astro.julian_tt(cycles.parse_utc(event['utc'])), body)[0]
                    self.assertLess(abs(cycles.angle_delta(actual, natal + cycles.BODIES[body][3])), 1e-7)
                    self.assertGreater(event['cycle'], 0)
                if body in ('neptune', 'pluto'):
                    self.assertEqual(result['events'], [])

    def test_chiron_file_checksum_range_and_first_return(self):
        path = astro.ROOT / 'data/ephe/seas_18.se1'
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), 'a2cd8fc33807c78ca9a700c91c2e042258b12fc4796519e00781440b5ad8b2e2')
        for date in ('1801-01-01T00:00:00Z', '2399-12-31T23:59:59Z'):
            cycles.position(astro.julian_tt(cycles.parse_utc(date)), 'chiron')
            source, start, end, de_number = astro.swe.get_current_file_data(2)
            self.assertEqual(path, pathlib.Path(source))
            self.assertEqual(de_number, 441)
            self.assertLessEqual(start, astro.julian_tt(cycles.parse_utc(date)))
            self.assertGreaterEqual(end, astro.julian_tt(cycles.parse_utc(date)))
        events = cycles.events(dict(birthUtc=BIRTH, body='chiron', fromAge=45, toAge=55))['events']
        self.assertEqual(len(events), 3)
        self.assertTrue(all(50 < event['age'] < 51 for event in events))
        self.assertEqual([event['pass'] for event in events], [1, 2, 3])
        self.assertEqual(events[0]['utc'][:19], '2050-03-07T19:41:29')
        chart = cycles.chart(dict(birthUtc=BIRTH, body='chiron', eventUtc=events[0]['utc']))['chart']
        for side in ('personality', 'design'):
            self.assertEqual(len(chart['activations'][side]), 13)
            self.assertNotIn('chiron', [item['planet'] for item in chart['activations'][side]])

    def test_true_node_three_passes_match_independent_fine_scan(self):
        birth = cycles.parse_utc('1970-01-01T00:00:00Z')
        events = cycles.search_events(birth, 'north_node', 18, 20)
        self.assertEqual([event['direction'] for event in events], ['retrograde', 'direct', 'retrograde'])
        self.assertEqual([event['pass'] for event in events], [1, 2, 3])
        target = cycles.position(astro.julian_tt(birth), 'north_node')[0]
        low = astro.julian_tt(cycles.parse_utc('1988-09-01T00:00:00Z'))
        end = astro.julian_tt(cycles.parse_utc('1988-10-01T00:00:00Z'))
        def residual(jd):
            return cycles.angle_delta(cycles.position(jd, 'north_node')[0], target)
        roots = []
        while low < end:
            high = min(end, low + 1 / 24)
            if residual(low) * residual(high) < 0:
                roots.append(cycles.bisect_root(residual, low, high))
            low = high
        self.assertEqual(len(roots), 3)
        for event, root in zip(events, roots):
            self.assertLess(abs((cycles.parse_utc(event['utc']) - astro.tt_to_datetime(root)).total_seconds()), 0.01)

    def test_missing_chiron_and_fallback_ephemerides_are_explicit(self):
        with patch.object(astro.swe, 'calc', side_effect=astro.swe.Error('Missing asteroid file')):
            with self.assertRaises(ChartError) as failure:
                cycles.position(2451544.5, 'chiron')
        self.assertEqual(failure.exception.payload['error'], 'ephemeris_unavailable')
        self.assertEqual(failure.exception.payload['body'], 'chiron')
        with patch.object(astro.swe, 'calc', return_value=((1, 0, 1, 0, 0, 0), astro.swe.FLG_MOSEPH)):
            with self.assertRaises(ChartError):
                cycles.position(2451544.5, 'sun')

    def test_chart_near_last_supported_day_does_not_search_into_missing_year(self):
        result = cycles.chart(dict(birthUtc='2300-12-31T00:00:00Z', body='sun', eventUtc='2399-12-31T00:21:01.568293Z'))
        self.assertEqual(result['event']['cycle'], 99)
        self.assertEqual(result['chart']['birthDate'], '2399-12-31')

    def test_input_and_ephemeris_boundaries(self):
        for value in ('2000-02-30T00:00:00Z', '2000-01-01T00:00Z', '2000-01-01T00:00:00+03:00', '1800-01-01T00:00:00Z', None):
            with self.subTest(value=value), self.assertRaises(ChartError):
                cycles.parse_utc(value)
        for low, high in ((0, 301), (0, 121), (2, 1), (True, 2), (0, float('nan'))):
            with self.subTest(low=low, high=high), self.assertRaises(ChartError):
                cycles.events(dict(birthUtc=BIRTH, body='moon', fromAge=low, toAge=high))
        with self.assertRaises(ChartError) as failure:
            cycles.events(dict(birthUtc='2399-01-01T00:00:00Z', body='sun', fromAge=0, toAge=2))
        self.assertEqual(failure.exception.payload['error'], 'unsupported_date')


class VerifiedChartTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.moon = cycles.events(dict(birthUtc=BIRTH, body='moon', fromAge=0, toAge=100))['events'][-1]
        cls.saturn = cycles.events(dict(birthUtc=BIRTH, body='saturn', fromAge=28, toAge=30))['events'][-1]
        cls.opposition = cycles.events(dict(birthUtc=BIRTH, body='uranus_opposition', fromAge=42, toAge=44))['events'][1]

    def test_verified_events_keep_the_exact_chart_and_pass_without_repeating_the_life_search(self):
        for event in (self.moon, self.saturn, self.opposition):
            with self.subTest(body=event['body']):
                request = dict(birthUtc=BIRTH, body=event['body'], eventUtc=event['utc'], timezone='Europe/London')
                expected = cycles.chart(request)
                with patch.object(cycles, 'search_events', side_effect=AssertionError('Repeated full search')), \
                     patch.object(cycles, 'position', wraps=cycles.position) as position:
                    actual = cycles.chart(request, verified_event=event)
                self.assertEqual(position.call_count, 2, 'only natal and event longitude verify the trusted crossing')
                self.assertEqual(actual['event'], expected['event'])
                for result in (actual, expected):
                    for key in ('createdAt', 'updatedAt'):
                        result['chart'].pop(key)
                self.assertEqual(actual['chart'], expected['chart'])
                self.assertEqual(actual['chart']['utc'], event['utc'])

    def test_only_the_private_worker_argument_uses_the_verified_event(self):
        event = self.saturn
        request = dict(action='chart', birthUtc=BIRTH, body='saturn', eventUtc=event['utc'])
        with patch.object(cycles, 'search_events', side_effect=AssertionError('Repeated full search')):
            result = cycles.calculate(dict(request, verifiedEvent=event))
        self.assertEqual(result['event'], event)
        forged = dict(event, cycle=999, cycleId='saturn:999')
        with patch.object(cycles, 'search_events', wraps=cycles.search_events) as search:
            ordinary = cycles.chart(dict(request, verifiedEvent=forged))
        self.assertEqual(search.call_count, 1, 'an ordinary chart request cannot grant itself trusted event ownership')
        self.assertEqual(ordinary['event']['cycle'], event['cycle'])
        self.assertEqual(ordinary['event']['pass'], 3)

    def test_verified_event_binding_and_angular_residual_are_still_checked(self):
        event = self.moon
        request = dict(birthUtc=BIRTH, body='moon', eventUtc=event['utc'])
        shifted = cycles.parse_utc(event['utc']) + cycles.dt.timedelta(seconds=2)
        shifted_utc = cycles.exact_iso(shifted)
        shifted_event = dict(event, utc=shifted_utc, id=f'moon:{shifted_utc}',
            age=(shifted - cycles.parse_utc(BIRTH)).total_seconds() / (86400 * cycles.YEAR_DAYS))
        for selected, data in ((dict(event, body='saturn'), request),
            (dict(event, utc=shifted_utc), request),
            (event, dict(request, birthUtc='2000-01-06T00:00:00Z')),
            (shifted_event, dict(request, eventUtc=shifted_utc))):
            with self.subTest(selected=selected, request=data), \
                 patch.object(cycles, 'search_events', side_effect=AssertionError('Repeated full search')), \
                 self.assertRaises(ChartError) as failure:
                cycles.chart(data, verified_event=selected)
            self.assertEqual(failure.exception.payload['error'], 'invalid_event')
        with patch.object(cycles, 'position', side_effect=ChartError('ephemeris_unavailable', 'Missing exact files')), \
             self.assertRaises(ChartError) as failure:
            cycles.chart(request, verified_event=event)
        self.assertEqual(failure.exception.payload['error'], 'ephemeris_unavailable')


if __name__ == '__main__':
    unittest.main()
