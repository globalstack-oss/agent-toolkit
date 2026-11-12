// The app clock for the failure sandbox: `sandbox.mjs advance` moves your app's clock with the sandbox's.
// Only for the app under test, started from `sandbox.mjs start --app-clock`, which prints how to load it:
//   NODE_OPTIONS="--import <file URL of this file>" GLOBALSTACK_SANDBOX_CLOCK=<.globalstack-sandbox/clock>
// The sandbox writes an offset in milliseconds to $GLOBALSTACK_SANDBOX_CLOCK. When it changes, `Date` moves
// forward by the difference and every timer the jump made due fires at once, so a poller set to every
// 30 minutes runs right after a 3-hour jump. Real timers keep running for everything else.
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const file = process.env.GLOBALSTACK_SANDBOX_CLOCK;
const isNpm = /npm-cli|npx-cli/.test(process.argv[1] ?? '');

if (file && !isNpm) install(file);

function install(clockFile) {
  const require = createRequire(import.meta.url);
  const timers = require('node:timers');
  const timersPromises = require('node:timers/promises');
  const RealDate = globalThis.Date;
  const real = {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearTimeout: globalThis.clearTimeout,
    clearInterval: globalThis.clearInterval,
    setImmediate: globalThis.setImmediate,
    now: () => RealDate.now(),
  };
  let offset = 0;

  globalThis.Date = new Proxy(RealDate, {
    construct(target, args) {
      return args.length ? new target(...args) : new target(target.now() + offset);
    },
    apply(target) {
      return new target(target.now() + offset).toString();
    },
    get(target, prop, receiver) {
      if (prop === 'now') return () => target.now() + offset;
      return Reflect.get(target, prop, receiver);
    },
  });

  /** handle -> { due, fire, interval } with `due` in real milliseconds */
  const tracked = new Map();

  // Only the app's own timers move with the clock. Node's internals (fetch sockets, headers timeouts)
  // keep real time, or a jump would cut live connections.
  const internal = () => {
    const caller = (new Error().stack ?? '').split('\n').slice(1).find((line) => !line.includes('clock.mjs'));
    return caller ? /node:internal|internal\/deps|undici/.test(caller) : false;
  };

  function setTimeoutShifted(fn, ms = 0, ...args) {
    if (typeof fn !== 'function' || internal()) return real.setTimeout(fn, ms, ...args);
    const delay = Math.max(0, Number(ms) || 0);
    const handle = real.setTimeout(() => {
      tracked.delete(handle);
      fn(...args);
    }, delay);
    tracked.set(handle, { due: real.now() + delay, fire: () => fn(...args), interval: 0 });
    return handle;
  }

  function setIntervalShifted(fn, ms = 0, ...args) {
    if (typeof fn !== 'function' || internal()) return real.setInterval(fn, ms, ...args);
    const every = Math.max(1, Number(ms) || 1);
    const entry = { due: real.now() + every, fire: () => fn(...args), interval: every };
    const handle = real.setInterval(() => {
      entry.due = real.now() + every;
      fn(...args);
    }, every);
    tracked.set(handle, entry);
    return handle;
  }

  function clearShifted(handle) {
    if (handle && tracked.has(handle)) tracked.delete(handle);
    real.clearTimeout(handle);
  }

  function sleepShifted(ms, value, options = {}) {
    return new Promise((resolve, reject) => {
      const { signal } = options;
      if (signal?.aborted) return reject(signal.reason);
      const handle = setTimeoutShifted(() => resolve(value), ms);
      signal?.addEventListener('abort', () => {
        clearShifted(handle);
        reject(signal.reason);
      }, { once: true });
    });
  }

  globalThis.setTimeout = setTimeoutShifted;
  globalThis.setInterval = setIntervalShifted;
  globalThis.clearTimeout = clearShifted;
  globalThis.clearInterval = clearShifted;
  timers.setTimeout = setTimeoutShifted;
  timers.setInterval = setIntervalShifted;
  timers.clearTimeout = clearShifted;
  timers.clearInterval = clearShifted;
  timersPromises.setTimeout = sleepShifted;
  syncBuiltinESMExports();

  function jump(delta) {
    const now = real.now();
    for (const [handle, entry] of [...tracked]) {
      if (entry.due - now > delta) continue;
      if (entry.interval) {
        entry.due = now + entry.interval;
      } else {
        real.clearTimeout(handle);
      }
      // Fire on the next turn, unless the app clears the timer before then.
      real.setImmediate(() => {
        if (tracked.get(handle) !== entry) return;
        if (!entry.interval) tracked.delete(handle);
        entry.fire();
      });
    }
  }

  function read() {
    try {
      const next = Number(fs.readFileSync(clockFile, 'utf8').trim()) || 0;
      if (next > offset) {
        const delta = next - offset;
        offset = next;
        jump(delta);
      }
    } catch {
      // no clock file yet: no offset
    }
  }

  read();
  real.setInterval(read, 100).unref();
}
