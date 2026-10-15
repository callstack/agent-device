import { createHash } from 'node:crypto';

/** Global the runtime installs itself on inside the app's JavaScript runtime. */
export const REACT_DEVTOOLS_RUNTIME_GLOBAL = '__AGENT_DEVICE_REACT_DEVTOOLS__';

/**
 * Source evaluated inside the app through CDP `Runtime.evaluate`. It installs
 * `globalThis.__AGENT_DEVICE_REACT_DEVTOOLS__` once per JavaScript runtime; every host command is
 * then a one-line call returning a JSON string. Hermes evaluates it unbundled, so it stays ES5.
 *
 * It drives the React DevTools backend that React Native dev builds already ship:
 * - React Native 0.79+ attaches renderer interfaces when React registers with the global hook.
 * - React Native 0.76-0.78 attaches them when the `react-devtools` Fusebox domain initializes; a
 *   discarding frontend binding stands in until a real frontend replaces it.
 * - Older versions attach them through `react-devtools-core`'s custom messaging connection.
 *
 * Component names, keys, the tree, and per-component error and warning counts come from the
 * backend's `operations` stream. Without a frontend the backend queues those batches forever, so
 * the runtime flushes the queue once, which replays the tree from app start and switches the
 * backend to emitting each commit's batch. When another DevTools agent already consumes the
 * stream, its frontend owns the queue: the runtime only reads the batches that follow and looks up
 * the names it missed, and it has no tree to offer.
 *
 * Props, state, hooks, and owners come from the backend's `inspectElement`, the call the DevTools
 * frontend makes when a component is selected.
 */
export const REACT_DEVTOOLS_RUNTIME_SOURCE = String.raw`
(function (VERSION) {
  var g = globalThis;
  var previous = g.__AGENT_DEVICE_REACT_DEVTOOLS__;
  if (previous && previous.version === VERSION) return 'ready';
  var inherited = previous && previous.elements instanceof Map ? previous.elements : null;
  var inheritedHistory = !!(previous && previous.history);
  var inheritedOrder = previous && previous.order instanceof Map ? previous.order : null;
  var inheritedLogs = previous && previous.logs instanceof Map ? previous.logs : null;
  if (previous && typeof previous.dispose === 'function') previous.dispose();

  var BINDING = '__CHROME_DEVTOOLS_FRONTEND_BINDING__';
  var ROOT_TYPE = 11;
  var KNOWN_TYPES = { 1: 1, 2: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1, 11: 1, 12: 1, 13: 1, 14: 1, 15: 1, 16: 1, 17: 1 };
  var elements = inherited || new Map();
  var order = inheritedOrder || new Map();
  var logs = inheritedLogs || new Map();
  var history = inheritedHistory;
  var nextRequestID = 1;
  var decodable = true;
  var unsubscribe = null;
  var session = null;
  var standInBinding = null;

  function hook() { return g.__REACT_DEVTOOLS_GLOBAL_HOOK__; }
  function size(collection) { var n = 0; if (collection && collection.forEach) collection.forEach(function () { n++; }); return n; }
  function eachRenderer(fn) { var h = hook(); if (h && h.rendererInterfaces) h.rendererInterfaces.forEach(fn); }

  /**
   * React DevTools 7 added a name-prop field to each non-root ADD, in the same release that gave
   * renderer interfaces supportsTogglingSuspense.
   */
  function addLength(rendererID) {
    var h = hook();
    var ri = h && h.rendererInterfaces && h.rendererInterfaces.get ? h.rendererInterfaces.get(rendererID) : null;
    return ri && 'supportsTogglingSuspense' in ri ? 8 : 7;
  }

  /** Length of an op this runtime skips: the Suspense tree and Activity slice ops of DevTools 7+. */
  function skippedLength(ops, i) {
    var op = ops[i];
    if (op === 4 || op === 7) return 3;
    if (op === 6) return 1;
    if (op === 8) return 6 + 4 * Math.max(ops[i + 5], 0);
    if (op === 9) return 2 + ops[i + 1];
    if (op === 10) return 3 + ops[i + 2];
    if (op === 11) return 3 + 4 * Math.max(ops[i + 2], 0);
    if (op === 12) {
      var j = i + 2;
      for (var c = 0; c < ops[i + 1]; c++) j += 5 + ops[j + 4];
      return j - i;
    }
    if (op === 13) return 2;
    return 0;
  }

  function readOperations(ops) {
    var nonRootAdd = addLength(ops[0]);
    var strings = [null];
    var i = 3;
    var tableEnd = 3 + ops[2];
    while (i < tableEnd) {
      var length = ops[i++];
      var text = '';
      for (var k = 0; k < length; k++) text += String.fromCodePoint(ops[i + k]);
      i += length;
      strings.push(text);
    }
    while (i < ops.length) {
      var op = ops[i];
      if (op === 1) {
        var id = ops[i + 1];
        var type = ops[i + 2];
        if (KNOWN_TYPES[type] !== 1) return false;
        if (type !== ROOT_TYPE) {
          var nameIndex = ops[i + 5];
          var keyIndex = ops[i + 6];
          if (nameIndex >= strings.length || keyIndex >= strings.length) return false;
          elements.set(id, [strings[nameIndex] || 'Anonymous', type, ops[i + 4], ops[i + 3], strings[keyIndex]]);
        }
        i += type === ROOT_TYPE ? 7 : nonRootAdd;
      } else if (op === 2) {
        for (var r = 0; r < ops[i + 1]; r++) forget(ops[i + 2 + r]);
        i += 2 + ops[i + 1];
      } else if (op === 3) {
        order.set(ops[i + 1], ops.slice(i + 3, i + 3 + ops[i + 2]));
        i += 3 + ops[i + 2];
      } else if (op === 5) {
        if (ops[i + 2] || ops[i + 3]) logs.set(ops[i + 1], [ops[i + 2], ops[i + 3]]);
        else logs.delete(ops[i + 1]);
        i += 4;
      } else {
        var skipped = skippedLength(ops, i);
        if (!skipped) return false;
        i += skipped;
      }
    }
    return true;
  }

  /** A profile keeps the names of what unmounts while it records; the tree drops them at once. */
  function forget(id) {
    order.delete(id);
    logs.delete(id);
    if (session) session.removed.push(id);
    else elements.delete(id);
  }

  function naming() { return history && decodable ? 'operations' : 'lookup'; }

  function operationListenerCount(h) {
    var listeners = h.listeners && h.listeners.operations;
    return listeners ? listeners.length : 0;
  }

  function onOperations(ops) {
    if (!decodable) return;
    try { if (!readOperations(ops)) decodable = false; } catch (e) { decodable = false; }
  }

  function findDevtoolsCore() {
    var registry = g.__r && typeof g.__r.getModules === 'function' ? g.__r.getModules() : null;
    var found = null;
    function inspect(module) {
      if (found || !module || !module.isInitialized || !module.publicModule) return;
      var exports = module.publicModule.exports;
      if (exports && typeof exports.connectWithCustomMessagingProtocol === 'function') found = exports;
    }
    if (registry && typeof registry.forEach === 'function') registry.forEach(inspect);
    else if (registry) for (var key in registry) inspect(registry[key]);
    return found;
  }

  function connectBackend() {
    var dispatcher = g.__FUSEBOX_REACT_DEVTOOLS_DISPATCHER__;
    if (dispatcher) {
      if (g[BINDING] == null) {
        standInBinding = function () {};
        Object.defineProperty(g, BINDING, { value: standInBinding, configurable: true, writable: true });
      }
      dispatcher.initializeDomain('react-devtools');
      return 'fusebox-domain';
    }
    var core = findDevtoolsCore();
    if (!core) return null;
    core.connectWithCustomMessagingProtocol({
      onSubscribe: function () {},
      onUnsubscribe: function () {},
      onMessage: function () {}
    });
    return 'devtools-core';
  }

  function attach() {
    var h = hook();
    if (!h) return { ok: false, reason: 'no-devtools-hook' };
    if (size(h.renderers) === 0) return { ok: false, reason: 'no-react-renderer' };
    var foreignAgent = !unsubscribe && operationListenerCount(h) > 0;
    var connectedBy = null;
    if (size(h.rendererInterfaces) === 0) {
      connectedBy = connectBackend();
      if (!connectedBy) return { ok: false, reason: 'no-devtools-backend' };
      if (size(h.rendererInterfaces) === 0) return { ok: false, reason: 'backend-attach-failed' };
    }
    if (!unsubscribe) {
      unsubscribe = h.sub('operations', onOperations);
      var frontendBinding = g[BINDING] != null && g[BINDING] !== standInBinding;
      var ownsQueue = connectedBy !== null || (!foreignAgent && !frontendBinding && !!g.__FUSEBOX_REACT_DEVTOOLS_DISPATCHER__);
      if (!h.__agentDeviceOperationsFlushed && ownsQueue) {
        h.__agentDeviceOperationsFlushed = true;
        history = true;
        eachRenderer(function (ri) { ri.flushInitialOperations(); });
      }
    }
    return { ok: true, attach: connectedBy || 'attached', naming: naming() };
  }

  function lookupName(ri, id) {
    var lookup = ri.getDisplayNameForElementID || ri.getDisplayNameForFiberID;
    try { return lookup ? lookup.call(ri, id) : null; } catch (e) { return null; }
  }

  function remember(ri, id, out) {
    if (out[id]) return;
    var known = elements.get(id);
    if (known) { out[id] = known; return; }
    var name = lookupName(ri, id);
    if (!name) return;
    out[id] = [name, 0, 0, 0];
    elements.set(id, out[id]);
  }

  function internAll(list, table) {
    if (!list || !list.length) return null;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var key = String(list[i]);
      var index = table.index[key];
      if (index === undefined) { index = table.index[key] = table.keys.length; table.keys.push(key); }
      out.push(index);
    }
    return out;
  }

  function compactChange(change, table) {
    if (!change) return 0;
    if (change.isFirstMount) return 1;
    var bits = (change.context === true || (change.context && change.context.length) ? 1 : 0) | (change.didHooksChange ? 2 : 0);
    var props = internAll(change.props, table);
    var state = internAll(change.state, table);
    var hooks = change.hooks && change.hooks.length ? change.hooks : null;
    if (!bits && !props && !state && !hooks) return 0;
    return [bits, props, state, hooks];
  }

  /** Reads back only the renderers this session started; another renderer has no recording. */
  function exportProfile(renderers) {
    var commits = [];
    var refs = Object.create(null);
    var keyTable = { keys: [], index: Object.create(null) };
    var failures = [];
    renderers.forEach(function (ri) {
      var data;
      try { ri.stopProfiling(); data = ri.getProfilingData(); } catch (e) {
        failures.push(String(e && e.message || e));
        return;
      }
      data.dataForRoots.forEach(function (root) {
        root.commitData.forEach(function (commit) {
          var fibers = [];
          var self = Object.create(null);
          var i;
          for (i = 0; i < commit.fiberSelfDurations.length; i++) self[commit.fiberSelfDurations[i][0]] = commit.fiberSelfDurations[i][1];
          for (i = 0; i < commit.fiberActualDurations.length; i++) {
            var entry = commit.fiberActualDurations[i];
            remember(ri, entry[0], refs);
            fibers.push(entry[0], entry[1], self[entry[0]] || 0);
          }
          var changes = null;
          if (commit.changeDescriptions) {
            changes = Object.create(null);
            for (i = 0; i < commit.changeDescriptions.length; i++) {
              var compact = compactChange(commit.changeDescriptions[i][1], keyTable);
              if (compact !== 0) changes[commit.changeDescriptions[i][0]] = compact;
            }
          }
          var updaters = [];
          (commit.updaters || []).forEach(function (updater) {
            if (!refs[updater.id]) refs[updater.id] = elements.get(updater.id) || [updater.displayName || 'Anonymous', updater.type || 0, 0, 0];
            updaters.push(updater.id);
          });
          commits.push({
            timestamp: commit.timestamp,
            duration: commit.duration,
            updaters: updaters,
            fibers: fibers,
            changes: changes
          });
        });
      });
    });
    var owners = Object.create(null);
    Object.keys(refs).forEach(function (id) {
      var owner = refs[id][2];
      if (owner && !refs[owner] && !owners[owner] && elements.get(owner)) owners[owner] = elements.get(owner);
    });
    Object.keys(owners).forEach(function (id) { refs[id] = owners[id]; });
    Object.keys(refs).forEach(function (id) {
      for (var parent = refs[id][3]; parent && !refs[parent] && elements.get(parent); parent = refs[parent][3]) {
        refs[parent] = elements.get(parent);
      }
    });
    return { elements: refs, keys: keyTable.keys, commits: commits, failures: failures };
  }

  function propKind(value, path, cleaned) {
    for (var i = 0; cleaned && i < cleaned.length; i++) {
      if (cleaned[i].length === 1 && cleaned[i][0] === path) return value && value.type ? String(value.type) : 'object';
    }
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  function describeProps(request) {
    var out = Object.create(null);
    Object.keys(request).forEach(function (id) {
      var keys = request[id];
      eachRenderer(function (ri) {
        if (out[id]) return;
        var inspected;
        try { inspected = ri.inspectElement(nextRequestID++, Number(id), null, true); } catch (e) { return; }
        if (!inspected || inspected.type !== 'full-data' || !inspected.value || !inspected.value.props) return;
        var props = inspected.value.props;
        var data = props.data !== undefined ? props.data : props;
        var kinds = Object.create(null);
        keys.forEach(function (key) { if (data && key in data) kinds[key] = propKind(data[key], key, props.cleaned); });
        out[id] = kinds;
      });
    });
    return out;
  }

  function tree() {
    var attached = attach();
    if (!attached.ok) return attached;
    if (naming() !== 'operations') return { ok: false, reason: 'tree-unavailable' };
    var unmounted = Object.create(null);
    if (session) session.removed.forEach(function (id) { unmounted[id] = true; });
    var nodes = [];
    elements.forEach(function (element, id) {
      if (!unmounted[id]) nodes.push([id, element[0], element[1], element[3], element[2], element[4] == null ? null : element[4]]);
    });
    var childOrder = Object.create(null);
    order.forEach(function (children, id) { childOrder[id] = children; });
    var counts = Object.create(null);
    logs.forEach(function (count, id) { counts[id] = count; });
    var h = hook();
    var logsTracked = !!(h.settings && h.settings.showInlineWarningsAndErrors !== false);
    return { ok: true, nodes: nodes, order: childOrder, logs: counts, logsTracked: logsTracked };
  }

  function inspectOne(id) {
    var found = null;
    eachRenderer(function (ri) {
      if (found || (ri.hasElementWithId && !ri.hasElementWithId(id))) return;
      var result;
      try { result = ri.inspectElement(nextRequestID++, id, null, true); } catch (e) {
        found = { error: String(e && e.message || e) };
        return;
      }
      if (!result || result.type === 'not-found') return;
      if (result.type !== 'full-data') { found = { error: result.message || result.type }; return; }
      var value = result.value;
      var known = elements.get(id);
      found = {
        name: known ? known[0] : lookupName(ri, id),
        type: value.type,
        key: value.key == null ? null : value.key,
        props: value.props,
        state: value.state,
        hooks: value.hooks,
        context: value.context,
        owners: value.owners,
        errors: value.errors,
        warnings: value.warnings,
        isErrored: !!value.isErrored
      };
    });
    return found || { missing: true };
  }

  function inspect(ids) {
    var attached = attach();
    if (!attached.ok) return attached;
    var out = Object.create(null);
    ids.forEach(function (id) { out[id] = inspectOne(id); });
    return { ok: true, elements: out };
  }

  function start() {
    var attached = attach();
    if (!attached.ok) return attached;
    if (session) return { ok: false, reason: 'already-profiling', elapsedMs: Date.now() - session.startedAt };
    var started = [];
    eachRenderer(function (ri) {
      try { ri.startProfiling(true, false); started.push(ri); } catch (e) {}
    });
    if (started.length === 0) return { ok: false, reason: 'start-failed' };
    session = { startedAt: Date.now(), renderers: started, removed: [] };
    return { ok: true, attach: attached.attach, naming: attached.naming };
  }

  function stop() {
    if (!session) return { ok: false, reason: 'not-profiling' };
    var startedAt = session.startedAt;
    var renderers = session.renderers;
    var profile = exportProfile(renderers);
    session.removed.forEach(function (id) { elements.delete(id); });
    session = null;
    if (profile.failures.length === renderers.length) {
      return { ok: false, reason: 'collect-failed', detail: profile.failures[0] };
    }
    return {
      ok: true,
      startedAt: startedAt,
      stoppedAt: Date.now(),
      naming: naming(),
      elements: profile.elements,
      keys: profile.keys,
      commits: profile.commits,
      failures: profile.failures
    };
  }

  function dispose() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    if (session) session.renderers.forEach(function (ri) { try { ri.stopProfiling(); } catch (e) {} });
    session = null;
  }

  g.__AGENT_DEVICE_REACT_DEVTOOLS__ = {
    version: VERSION,
    elements: elements,
    order: order,
    logs: logs,
    get history() { return history; },
    start: function () { return JSON.stringify(start()); },
    stop: function () { return JSON.stringify(stop()); },
    describeProps: function (request) { return JSON.stringify(describeProps(request)); },
    tree: function () { return JSON.stringify(tree()); },
    inspect: function (ids) { return JSON.stringify(inspect(ids)); },
    dispose: dispose
  };
  return 'installed';
})
`;

/**
 * Identity of this runtime source. An app that holds a runtime with another identity replaces it
 * instead of calling into an incompatible one.
 */
export const REACT_DEVTOOLS_RUNTIME_VERSION = createHash('sha256')
  .update(REACT_DEVTOOLS_RUNTIME_SOURCE)
  .digest('hex')
  .slice(0, 16);
