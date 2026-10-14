// The fetch tripwire for every check and dry script: replaces globalThis.fetch with a function that throws, so a stray
// paid call fails the run instead of billing. `installTripwire()` returns the uninstall function; `hits` counts calls.
// A check that needs a fake transport passes it as `fetchImpl` to the gateway instead of touching the global.
export function installTripwire({ message = 'fetch tripwire: a paid or network call was attempted' } = {}) {
  const real = globalThis.fetch;
  const wire = { hits: 0, uninstall() { globalThis.fetch = real; } };
  globalThis.fetch = () => {
    wire.hits++;
    throw new Error(message);
  };
  const uninstall = () => wire.uninstall();
  uninstall.wire = wire;
  return uninstall;
}
