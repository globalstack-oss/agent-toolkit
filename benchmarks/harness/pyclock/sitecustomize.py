# Clock jump for a Python app under test: the Python counterpart of clock.mjs, loaded through PYTHONPATH.
# The grader writes an offset in milliseconds to $EVAL_CLOCK_FILE. When it changes, wall-clock reads
# (time.time, datetime.now, date.today: time-machine patches them in C) move forward by the difference,
# and every sleep (time.sleep, asyncio.sleep, threading.Event.wait) whose deadline the jump passed ends
# at once, so a poller that sleeps 30 minutes runs right after a 3-hour jump. Monotonic clocks keep
# real time, so the server's own socket and request timeouts are untouched.
import os

_CLOCK_FILE = os.environ.get('EVAL_CLOCK_FILE')


def _install(clock_file):
    import asyncio
    import threading
    import time
    from datetime import datetime, timezone

    import time_machine

    real_sleep = time.sleep
    real_async_sleep = asyncio.sleep
    real_event_wait = threading.Event.wait
    traveller = time_machine.travel(datetime.now(timezone.utc), tick=True).start()
    applied = [0.0]  # offset already applied, in seconds
    step = 0.1

    def read_offset():
        try:
            with open(clock_file) as f:
                return float(f.read().strip() or 0) / 1000.0
        except (OSError, ValueError):
            return applied[0]

    def watch():
        while True:
            target = read_offset()
            if target != applied[0]:
                traveller.shift(target - applied[0])
                applied[0] = target
            real_sleep(step)

    threading.Thread(target=watch, name='eval-clock', daemon=True).start()

    def sleep(seconds):
        if seconds <= step:
            return real_sleep(seconds)
        deadline = time.time() + seconds
        while (left := deadline - time.time()) > 0:
            real_sleep(min(left, step))

    async def async_sleep(delay, result=None):
        if delay <= step:
            return await real_async_sleep(delay, result)
        deadline = time.time() + delay
        while (left := deadline - time.time()) > 0:
            await real_async_sleep(min(left, step))
        return result

    def event_wait(self, timeout=None):
        if timeout is None or timeout <= step:
            return real_event_wait(self, timeout)
        deadline = time.time() + timeout
        while (left := deadline - time.time()) > 0:
            if real_event_wait(self, min(left, step)):
                return True
        return self.is_set()

    time.sleep = sleep
    asyncio.sleep = async_sleep
    asyncio.tasks.sleep = async_sleep
    threading.Event.wait = event_wait


if _CLOCK_FILE:
    try:
        _install(_CLOCK_FILE)
    except ImportError:
        pass  # not the eval's Python environment: leave the clock alone
