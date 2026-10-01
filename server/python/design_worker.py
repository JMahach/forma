"""Bounded Design-only JSON-lines session; each point uses the scalar exact search."""
import json
import sys

if __package__:
    from .calculator import calculate
    from .errors import ChartError
else:
    from calculator import calculate
    from errors import ChartError

MAX_INPUT_BYTES = 512


def serve(source, destination):
    while True:
        line = source.readline(MAX_INPUT_BYTES + 1)
        if not line:
            return
        if len(line) > MAX_INPUT_BYTES or not line.endswith(b'\n'):
            raise ValueError('Invalid session frame')
        request = json.loads(line)
        if (not isinstance(request, dict) or set(request) != {'id', 'utc'}
                or type(request['id']) is not int or not 0 < request['id'] <= 9007199254740991
                or not isinstance(request['utc'], str) or len(request['utc']) > 64):
            raise ValueError('Invalid session request')
        try:
            # No predicted search state, saved inputs or per-request Swiss flags.
            result = calculate(dict(mode='transit_design', utc=request['utc']))
        except ChartError as error:
            result = error.payload
        # Unexpected engine failures end the session. Node owns replacement.
        destination.write(json.dumps(dict(id=request['id'], result=result), ensure_ascii=False, allow_nan=False) + '\n')
        destination.flush()


if __name__ == '__main__':
    serve(sys.stdin.buffer, sys.stdout)
