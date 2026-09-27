"""Structured calculation errors shared by all three JSON scenarios."""

class ChartError(Exception):
    def __init__(self, code, message, **extra):
        super().__init__(message)
        self.payload = dict(error=code, message=message, **extra)
