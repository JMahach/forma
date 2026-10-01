"""Session framing and exact scalar parity; no saved predictor crosses requests."""
import io
import json
import pathlib
import struct
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from server.python import calculator, design_worker


def frame(identity, utc):
    return (json.dumps(dict(id=identity, utc=utc)) + '\n').encode()


class DesignWorkerTests(unittest.TestCase):
    def test_multiple_nonchronological_requests_match_scalar_float_bits(self):
        moments = ['1801-01-01T00:00:00Z', '2399-12-31T23:59:59.999Z',
                   '2000-02-29T12:34:56.789Z', '1900-03-01T00:00:00Z',
                   '1801-01-01T00:00:00Z']
        output = io.StringIO()
        design_worker.serve(io.BytesIO(b''.join(frame(i + 1, utc) for i, utc in enumerate(moments))), output)
        responses = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(responses), len(moments))
        for i, (utc, response) in enumerate(zip(moments, responses)):
            expected = calculator.calculate(dict(mode='transit_design', utc=utc))
            self.assertEqual(response, dict(id=i + 1, result=expected))
            for actual, value in zip(response['result']['longitudes'], expected['longitudes']):
                self.assertEqual(struct.pack('d', actual), struct.pack('d', value))
            self.assertEqual(struct.pack('d', response['result']['designArcResidualDegrees']),
                             struct.pack('d', expected['designArcResidualDegrees']))

    def test_domain_error_keeps_stream_usable_and_each_request_calls_scalar(self):
        output = io.StringIO()
        with mock.patch.object(design_worker, 'calculate', wraps=calculator.calculate) as calculate:
            design_worker.serve(io.BytesIO(frame(1, 'invalid') + frame(2, '2026-09-30T00:00:00Z')), output)
        values = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertIn('error', values[0]['result'])
        self.assertEqual(values[1]['result']['utc'], '2026-09-30T00:00:00Z')
        self.assertEqual(calculate.call_args_list, [
            mock.call(dict(mode='transit_design', utc='invalid')),
            mock.call(dict(mode='transit_design', utc='2026-09-30T00:00:00Z'))])

    def test_invalid_or_oversized_frame_ends_session_without_calculation(self):
        invalid = [b'x' * 513, frame(1, 'x' * 65), b'{bad}\n', frame(True, 'x'),
                   frame(0, 'x'), frame(9007199254740992, 'x'), frame(1, 'x')[:-1],
                   b'{"id":1,"utc":"x","mode":"natal"}\n', b'[]\n', b'null\n']
        for value in invalid:
            with self.subTest(value=value[:80]), mock.patch.object(design_worker, 'calculate') as calculate:
                output = io.StringIO()
                with self.assertRaises((ValueError, TypeError)):
                    design_worker.serve(io.BytesIO(value + frame(2, '2026-09-30T00:00:00Z')), output)
                calculate.assert_not_called()
                self.assertEqual(output.getvalue(), '')

    def test_unexpected_failure_terminates_instead_of_reusing_unknown_engine_state(self):
        with mock.patch.object(design_worker, 'calculate', side_effect=RuntimeError('engine failure')) as calculate:
            output = io.StringIO()
            with self.assertRaises(RuntimeError):
                design_worker.serve(io.BytesIO(frame(1, 'x') + frame(2, 'y')), output)
            self.assertEqual(calculate.call_count, 1)
            self.assertEqual(output.getvalue(), '')


if __name__ == '__main__':
    unittest.main()
