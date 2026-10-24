import { createHash } from 'node:crypto';

/** Global the capture installs on inside the app's JavaScript runtime. */
export const NETWORK_CAPTURE_RUNTIME_GLOBAL = '__AGENT_DEVICE_NETWORK__';

/** Entries the ring buffer holds; the oldest is dropped when it is full. */
export const NETWORK_CAPTURE_MAX_ENTRIES = 200;

/** Characters kept per header value inside the app, on top of the payload budget. */
export const NETWORK_CAPTURE_HEADER_CHARS = 512;

/**
 * Source evaluated inside the app through CDP `Runtime.evaluate`. It installs
 * `globalThis.__AGENT_DEVICE_NETWORK__` once per JavaScript runtime and patches the two network
 * surfaces a React Native app uses — `fetch` and `XMLHttpRequest` — recording one bounded entry
 * per completed request. Hermes evaluates it unbundled, so it stays ES5.
 *
 * Each entry keeps the request identity (method, full URL, status, duration, ISO timestamp), the
 * header pairs, and both bodies capped at BODY_CAP for textual content types. Redaction never
 * happens in the app: the host applies its own secret rules when it reads the buffer. `drain`
 * removes and returns the entries it hands over, so two dumps of one session never repeat an
 * entry, and an app reload resets the buffer together with the runtime that holds it.
 */
export const NETWORK_CAPTURE_RUNTIME_SOURCE = String.raw`
(function (VERSION, MAX_ENTRIES, BODY_CAP, HEADER_CAP) {
  var g = globalThis;
  var existing = g.__AGENT_DEVICE_NETWORK__;
  if (existing && typeof existing.drain === 'function' && typeof existing.stats === 'function') {
    return 'ready';
  }
  var entries = [];
  var captured = 0;
  var dropped = 0;
  var patchedFetch = false;
  var patchedXhr = false;
  var fetchInFlight = {};

  // whatwg-fetch polyfills fetch on top of XMLHttpRequest. While a wrapped fetch() call runs
  // synchronously, its URL is claimed; an XHR send inside that window belongs to that fetch and
  // must not record a second entry. The window closes when fetch() returns.
  function claimFetch(url) {
    fetchInFlight[url] = (fetchInFlight[url] || 0) + 1;
    return function () {
      fetchInFlight[url] = (fetchInFlight[url] || 0) - 1;
      if (fetchInFlight[url] <= 0) delete fetchInFlight[url];
    };
  }

  function fetchClaims(url) {
    return patchedFetch && fetchInFlight[url] > 0;
  }

  function cap(value) {
    var text = String(value);
    return text.length <= BODY_CAP ? text : text.slice(0, BODY_CAP);
  }

  function capHeader(value) {
    var text = String(value);
    return text.length <= HEADER_CAP ? text : text.slice(0, HEADER_CAP);
  }

  function isBinaryContentType(contentType) {
    return contentType !== undefined && contentType !== '' &&
      !/text\/|json|xml|javascript|x-www-form-urlencoded|svg/i.test(String(contentType));
  }

  function bodyValue(body) {
    if (body == null) return undefined;
    if (typeof body === 'string') return cap(body);
    try {
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        return cap(body.toString());
      }
    } catch (e) {}
    if (typeof body !== 'object' || typeof body.getReader === 'function') return undefined;
    if (typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) {
      return undefined;
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) return undefined;
    if (typeof FormData !== 'undefined' && body instanceof FormData) return undefined;
    try {
      var json = JSON.stringify(body);
      return json === undefined ? undefined : cap(json);
    } catch (e) {
      return undefined;
    }
  }

  function headerPairs(source) {
    var out = {};
    if (!source) return out;
    var count = 0;
    if (typeof source.forEach === 'function') {
      try {
        source.forEach(function (value, name) {
          if (count >= 64) return;
          count += 1;
          out[name] = capHeader(value);
        });
      } catch (e) {}
      return out;
    }
    try {
      Object.keys(source).forEach(function (name) {
        if (count >= 64) return;
        count += 1;
        out[name] = capHeader(source[name]);
      });
    } catch (e) {}
    return out;
  }

  function record(entry) {
    captured += 1;
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) {
      var evicted = entries.length - MAX_ENTRIES;
      dropped += evicted;
      entries.splice(0, evicted);
    }
  }

  function instrumentFetch(fetch) {
    if (typeof fetch !== 'function' || fetch.__agentDeviceCapture === true) return false;
    var wrapped = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url ? String(input.url) : String(input));
      var method = 'GET';
      if (init && init.method) method = String(init.method);
      else if (input && typeof input === 'object' && input.method) method = String(input.method);
      method = method.toUpperCase();
      var requestBody = bodyValue(init && init.body !== undefined ? init.body : undefined);
      var requestHeaders = headerPairs(init && init.headers ? init.headers : (input && input.headers));
      var startedAt = Date.now();
      var began = new Date(startedAt).toISOString();
      var release = claimFetch(url);
      var promise;
      try {
        promise = fetch.apply(this, arguments);
      } catch (e) {
        release();
        record({
          timestamp: began,
          method: method,
          url: url,
          durationMs: Date.now() - startedAt,
          requestHeaders: requestHeaders,
          error: String((e && e.message) || e),
          transport: 'fetch'
        });
        throw e;
      }
      // The claim spans only this synchronous call: a fetch polyfilled on XHR builds and sends
      // its request here, so the XHR sees the claim; a real async fetch never touches
      // XMLHttpRequest during this window, and later XHRs to the same URL stay their own entry
      // even while this request is in flight or after it fails.
      release();
      if (!promise || typeof promise.then !== 'function') return promise;
      return promise.then(
        function (response) {
          var entry = {
            timestamp: began,
            method: method,
            url: url,
            status: response && typeof response.status === 'number' ? response.status : undefined,
            durationMs: Date.now() - startedAt,
            requestHeaders: requestHeaders,
            responseHeaders: headerPairs(response && response.headers),
            transport: 'fetch'
          };
          if (requestBody !== undefined) entry.requestBody = requestBody;
          var contentType;
          try { contentType = response && response.headers && response.headers.get('content-type'); } catch (e) {}
          var clone = response && typeof response.clone === 'function' ? response.clone() : undefined;
          if (clone && typeof clone.text === 'function' && !isBinaryContentType(contentType)) {
            // Record in a detached chain: the app receives its response at once, and the entry
            // joins the buffer when the body read settles. A drain taken inside that window
            // reports this request on a later dump, never half-written, and never delays the app
            // for the whole read.
            clone.text().then(
              function (text) {
                entry.responseBody = cap(text);
                record(entry);
              },
              function () {
                record(entry);
              }
            );
            return response;
          }
          record(entry);
          return response;
        },
        function (error) {
          record({
            timestamp: began,
            method: method,
            url: url,
            durationMs: Date.now() - startedAt,
            requestHeaders: requestHeaders,
            error: String((error && error.message) || error),
            transport: 'fetch'
          });
          throw error;
        }
      );
    };
    wrapped.__agentDeviceCapture = true;
    return wrapped;
  }

  function instrumentXHR(prototype) {
    if (!prototype || typeof prototype.open !== 'function' || typeof prototype.send !== 'function') {
      return false;
    }
    if (prototype.send.__agentDeviceCapture === true) return false;
    var open = prototype.open;
    var send = prototype.send;
    var setRequestHeader = prototype.setRequestHeader;
    prototype.open = function (method, url) {
      this.__agentDeviceRequest = {
        method: String(method || 'GET').toUpperCase(),
        url: String(url),
        headers: {}
      };
      return open.apply(this, arguments);
    };
    if (typeof setRequestHeader === 'function') {
      prototype.setRequestHeader = function (name, value) {
        if (this.__agentDeviceRequest)
          this.__agentDeviceRequest.headers[name] = capHeader(value);
        return setRequestHeader.apply(this, arguments);
      };
    }
    var wrapped = function (body) {
      var state = this.__agentDeviceRequest;
      // A fetch polyfilled on XHR calls send synchronously inside the fetch wrapper, while the
      // wrapper's claim on this URL is held: that transport's XHR must not record a second entry.
      if (state && fetchClaims(state.url)) state.ownedByFetch = true;
      if (state && !state.ownedByFetch) {
        state.startedAt = Date.now();
        state.began = new Date(state.startedAt).toISOString();
        state.requestBody = bodyValue(body);
        var xhr = this;
        this.addEventListener('readystatechange', function () {
          if (xhr.readyState !== 4) return;
          var entry = {
            timestamp: state.began,
            method: state.method,
            url: state.url,
            status: xhr.status,
            durationMs: Date.now() - state.startedAt,
            requestHeaders: state.headers,
            transport: 'xhr'
          };
          if (state.requestBody !== undefined) entry.requestBody = state.requestBody;
          var responseType = xhr.responseType;
          if (responseType === '' || responseType === 'text') {
            try { entry.responseBody = cap(xhr.responseText); } catch (e) {}
          }
          try {
            var lines = String(xhr.getAllResponseHeaders() || '').split('\n');
            for (var i = 0; i < lines.length && i < 64; i++) {
              var split = lines[i].indexOf(':');
              if (split > 0) {
                entry.responseHeaders = entry.responseHeaders || {};
                entry.responseHeaders[lines[i].slice(0, split).trim()] = capHeader(
                  lines[i].slice(split + 1).trim()
                );
              }
            }
          } catch (e) {}
          record(entry);
        });
      }
      return send.apply(this, arguments);
    };
    wrapped.__agentDeviceCapture = true;
    prototype.send = wrapped;
    return true;
  }

  var wrappedFetch = instrumentFetch(g.fetch);
  if (wrappedFetch) {
    g.fetch = wrappedFetch;
    patchedFetch = true;
  }
  if (typeof XMLHttpRequest === 'function') {
    patchedXhr = instrumentXHR(XMLHttpRequest.prototype);
  }

  g.__AGENT_DEVICE_NETWORK__ = {
    version: VERSION,
    stats: function () {
      return JSON.stringify({
        ok: true,
        capturing: true,
        fetchPatched: patchedFetch,
        xhrPatched: patchedXhr,
        buffered: entries.length,
        captured: captured,
        dropped: dropped
      });
    },
    drain: function (limit) {
      var count = Math.max(0, Math.min(limit || 0, entries.length));
      var drained = entries.splice(entries.length - count, count);
      // Eviction accounting rides with the read it describes and resets here, so a later dump
      // never re-reports requests an earlier dump already said the buffer gave up.
      var evicted = dropped;
      dropped = 0;
      return JSON.stringify({ ok: true, entries: drained, dropped: evicted });
    }
  };
  return 'installed';
})
`;

/**
 * Identity of this runtime source. A runtime that already holds a capture keeps it: one stable
 * drain/stats shape serves every host build, so a reinstall never re-patches a patched surface.
 */
export const NETWORK_CAPTURE_RUNTIME_VERSION = createHash('sha256')
  .update(NETWORK_CAPTURE_RUNTIME_SOURCE)
  .digest('hex')
  .slice(0, 16);
