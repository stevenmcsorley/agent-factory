// Free, in-process JavaScript sandbox for Code Mode (QuickJS compiled to WASM). The sandbox has no network, filesystem,
// process or require: the only things it can call are the functions we inject. Optional dependency: `npm i quickjs-emscripten`.
const NS = 'factory'
let quickjs
export async function sandboxAvailable() { try { quickjs ??= await import('quickjs-emscripten'); return true } catch { return false } }
const FUNCTION_START = /^(async\s*)?(\(|function\b|[A-Za-z_$][\w$]*\s*=>)/
const normalise = (code) => {
  const c = code.trim().replace(/^```(?:js|javascript)?\s*|\s*```$/g, '').trim()
  return FUNCTION_START.test(c) ? c : `async () => {\n${c}\n}`
}

const PRELUDE = (names) => `
async function __c(n, a) {
  try { return JSON.parse(await __call(n, JSON.stringify(a === undefined ? {} : a))) }
  catch (e) { throw new Error(typeof e === 'string' ? e : (e && e.message) || String(e)) }
}
globalThis.${NS} = { ${names.map((n) => `${n}: (a) => __c(${JSON.stringify(n)}, a)`).join(', ')} };
globalThis.console = { log: (...a) => __log(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')) };
console.warn = console.error = console.info = console.log;
`

/**
 * Run `code` (an async function) in QuickJS. `fns` = { toolName: async (args) => value }.
 * Limits: wall-clock timeout (also interrupts synchronous loops), 64MB memory, 512KB stack, maxCalls host calls.
 */
export async function runSandboxed(code, fns, { timeoutMs = 60000, memoryBytes = 64 * 1024 * 1024, maxCalls = 32 } = {}) {
  const names = Object.keys(fns)
  if (names.some((n) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) throw new Error('Invalid tool name for sandbox namespace')
  if (!(await sandboxAvailable())) throw new Error('Code Mode needs the optional dependency: npm install quickjs-emscripten')
  const QuickJS = await quickjs.getQuickJS()
  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(memoryBytes)
  runtime.setMaxStackSize(512 * 1024)
  const deadline = Date.now() + timeoutMs
  runtime.setInterruptHandler(() => Date.now() > deadline)
  const vm = runtime.newContext()
  const logs = []
  let calls = 0
  let alive = true
  const deferreds = new Set()
  try {
    const logFn = vm.newFunction('__log', (h) => { if (logs.length < 200) logs.push(String(vm.getString(h)).slice(0, 2000)) })
    vm.setProp(vm.global, '__log', logFn); logFn.dispose()
    const callFn = vm.newFunction('__call', (nameH, jsonH) => {
      const name = vm.getString(nameH), json = vm.getString(jsonH)
      const d = vm.newPromise()
      deferreds.add(d)
      d.settled.then(() => { if (alive) runtime.executePendingJobs() })
      ;(async () => {
        try {
          if (++calls > maxCalls) throw new Error(`Execution exceeded ${maxCalls} factory calls`)
          if (!Object.hasOwn(fns, name)) throw new Error(`Unknown operation: ${name}`)
          const out = await fns[name](JSON.parse(json))
          if (!alive) return
          const h = vm.newString(JSON.stringify(out === undefined ? null : out)); d.resolve(h); h.dispose()
        } catch (e) {
          if (!alive) return
          const h = vm.newString(String(e?.message ?? e)); d.reject(h); h.dispose()
        }
      })()
      return d.handle
    })
    vm.setProp(vm.global, '__call', callFn); callFn.dispose()
    vm.unwrapResult(vm.evalCode(PRELUDE(names))).dispose()

    const started = vm.evalCode(`(async () => { const __f = (${normalise(code)}); const __r = await __f(); return JSON.stringify(__r === undefined ? null : __r) })()`)
    if (started.error) { const msg = JSON.stringify(vm.dump(started.error)); started.error.dispose(); return { result: undefined, error: msg, logs, calls } }
    const settled = vm.resolvePromise(started.value); started.value.dispose()
    runtime.executePendingJobs()
    let timer
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Execution timed out after ${timeoutMs}ms`)), timeoutMs) })
    let outcome
    try { outcome = await Promise.race([settled, timeout]) } finally { clearTimeout(timer) }
    if (outcome.error) {
      const e = vm.dump(outcome.error); outcome.error.dispose()
      return { result: undefined, error: typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e)), logs, calls }
    }
    const json = vm.getString(outcome.value); outcome.value.dispose()
    return { result: JSON.parse(json), logs, calls }
  } catch (e) {
    return { result: undefined, error: String(e?.message ?? e), logs, calls }
  } finally {
    alive = false
    for (const d of deferreds) { try { d.dispose() } catch { /* already disposed */ } }
    try { vm.dispose() } catch { /* leak assertion after timeout; runtime is discarded anyway */ }
    try { runtime.dispose() } catch { /* ignore */ }
  }
}

