/*
 * offline-tiles.js — offline-first raster tile layer for the GATI live map.
 *
 * WHY THIS EXISTS
 *   The 1 Sep demo room may have weak or no wifi. Basemap tiles normally come
 *   from CDNs (Esri imagery, CartoDB dark, OpenRailwayMap overlay). This factory
 *   serves each tile from a LOCAL pack first
 *       /tiles/<layer>/{z}/{x}/{y}.png     (built by fetch_tiles.py)
 *   and only falls back to the CDN, per-tile, when the local tile is missing.
 *   So a *partial* pack still works, and a *full* pack works with zero network.
 *
 * HONESTY NOTE (see CLAUDE.md §3, §8)
 *   The local pack is NOT committed to this repo by default and is NOT present
 *   in the dev sandbox (network egress is blocked there, so the bytes cannot be
 *   fetched in-environment). Until `fetch_tiles.py` is run on a networked
 *   machine with a *permitted* tile source, every local tile 404s and this layer
 *   transparently serves the CDN — i.e. today's online behaviour is unchanged.
 *   This is a resilience layer, not a claim that offline tiles already exist.
 */
(function () {
  'use strict';

  if (typeof L === 'undefined') {
    // Leaflet itself failed to load (offline AND not yet vendored). Nothing we
    // can do here; app.js/initMap will surface the real error. Don't throw and
    // block the rest of the page.
    console.error('[offline-tiles] Leaflet (L) is not defined — tile fallback disabled.');
    return;
  }

  // A subtle dark placeholder shown only when BOTH local and remote fail, so a
  // missing tile reads as an intentional dark grid, never a broken-image icon.
  var PLACEHOLDER =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">' +
        '<rect width="256" height="256" fill="#0d131f"/>' +
        '<rect x="0.5" y="0.5" width="255" height="255" fill="none" ' +
        'stroke="#1c2740" stroke-width="1"/>' +
      '</svg>'
    );

  var OfflineTileLayer = L.TileLayer.extend({
    options: {
      // Remote CDN template used per-tile when the local tile is missing.
      remoteTemplate: null,
      // Subdomains for the REMOTE template's {s} token (local packs have no {s}).
      remoteSubdomains: 'abc',
    },

    // Mirrors L.TileLayer.createTile (v1.9.x) exactly, except the 'error'
    // handler is our two-stage fallback instead of Leaflet's plain _tileOnError.
    createTile: function (coords, done) {
      var tile = document.createElement('img');

      L.DomEvent.on(tile, 'load', L.Util.bind(this._tileOnLoad, this, done, tile));
      L.DomEvent.on(
        tile,
        'error',
        L.Util.bind(this._offlineTileOnError, this, done, tile, coords)
      );

      if (this.options.crossOrigin || this.options.crossOrigin === '') {
        tile.crossOrigin = this.options.crossOrigin === true ? '' : this.options.crossOrigin;
      }
      if (typeof this.options.referrerPolicy === 'string') {
        tile.referrerPolicy = this.options.referrerPolicy;
      }
      tile.alt = '';

      // First attempt: the LOCAL pack (this._url is the local template).
      tile._triedRemote = false;
      tile.src = this.getTileUrl(coords);
      return tile;
    },

    _offlineTileOnError: function (done, tile, coords, e) {
      // Stage 1: local tile missing → try the remote CDN for THIS tile only.
      if (!tile._triedRemote && this.options.remoteTemplate) {
        tile._triedRemote = true;
        tile.src = this._remoteTileUrl(coords);
        return;
      }
      // Stage 2: remote also failed (or none configured) → let Leaflet apply
      // errorTileUrl (our dark placeholder) and finish the tile lifecycle.
      L.TileLayer.prototype._tileOnError.call(this, done, tile, e);
    },

    // Build the remote URL for a tile, mirroring L.TileLayer.getTileUrl but
    // using remoteTemplate + remoteSubdomains.
    _remoteTileUrl: function (coords) {
      var data = {
        r: L.Browser.retina ? '@2x' : '',
        s: this._getRemoteSubdomain(coords),
        x: coords.x,
        y: coords.y,
        z: this._getZoomForUrl(),
      };
      if (this._map && !this._map.options.crs.infinite) {
        var invertedY = this._globalTileRange.max.y - coords.y;
        if (this.options.tms) {
          data['y'] = invertedY;
        }
        data['-y'] = invertedY;
      }
      return L.Util.template(this.options.remoteTemplate, L.Util.extend(data, this.options));
    },

    _getRemoteSubdomain: function (coords) {
      var subs = this.options.remoteSubdomains || this.options.subdomains || 'abc';
      var index = Math.abs(coords.x + coords.y) % subs.length;
      return subs[index];
    },
  });

  // ── Pack manifest ────────────────────────────────────────────────────────
  // fetch_tiles.py writes /tiles/pack.json describing which layers were built
  // and to what zoom. We read it ONCE at startup so that:
  //   * with no pack, layers go straight to the CDN — no guaranteed-404 request
  //     per tile (that was ~350 console errors on a first load), and the online
  //     path stays byte-identical to a plain L.tileLayer;
  //   * with a pack, the built zoom range configures maxNativeZoom automatically,
  //     so there is no constant to hand-edit after a build.
  var pack = null;

  function loadPackManifest() {
    if (typeof fetch !== 'function') return Promise.resolve(null);
    return fetch('/tiles/pack.json', { cache: 'no-store' })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (json) {
        pack = json && json.layers ? json : null;
        if (pack) {
          console.info(
            '[offline-tiles] local pack found for layers: ' +
              Object.keys(pack.layers).join(', ')
          );
        }
        return pack;
      })
      .catch(function () {
        pack = null; // absent or malformed manifest → CDN-only, never fatal
        return null;
      });
  }

  /**
   * createOfflineLayer — build a raster tile layer, offline-first when a local
   * pack covers the requested layer and plain-CDN when it does not.
   *
   * @param {Object} opts
   * @param {string} opts.layer          logical layer name → /tiles/<layer>/...
   * @param {string} opts.remoteTemplate CDN URL template ({z}/{x}/{y}, {s}, {r})
   * @param {string} [opts.localTemplate] override the /tiles/<layer>/{z}/{x}/{y}.png default
   * @param {string} [opts.remoteSubdomains] subdomains for the remote {s} token
   * @param {...*}   [opts.*]            any other L.TileLayer option (attribution,
   *                                     maxZoom, opacity, subdomains…)
   *
   * Local storage is ALWAYS standard XYZ (`/tiles/<layer>/{z}/{x}/{y}.png`),
   * regardless of the remote's tile order — fetch_tiles.py maps each source's
   * native order onto this uniform local layout.
   *
   * Call loadPackManifest() and await it before the first createOfflineLayer(),
   * otherwise the pack is not yet known and every layer falls back to the CDN.
   */
  function createOfflineLayer(opts) {
    var entry = pack && pack.layers ? pack.layers[opts.layer] : null;

    var layerOpts = L.extend({}, opts, {
      errorTileUrl: opts.errorTileUrl || PLACEHOLDER,
    });

    if (!entry) {
      // No local tiles for this layer: skip the local attempt entirely.
      return L.tileLayer(opts.remoteTemplate, layerOpts);
    }

    // Cap native zoom at what the pack actually contains, so zooming past it
    // upscales local tiles (blurrier but present) instead of showing blanks
    // offline. Build the pack deeper for more sharpness.
    if (layerOpts.maxNativeZoom === undefined && typeof entry.maxZoom === 'number') {
      layerOpts.maxNativeZoom = entry.maxZoom;
    }
    layerOpts.remoteTemplate = opts.remoteTemplate;
    layerOpts.remoteSubdomains = opts.remoteSubdomains || opts.subdomains || 'abc';

    var localTemplate = opts.localTemplate || '/tiles/' + opts.layer + '/{z}/{x}/{y}.png';
    return new OfflineTileLayer(localTemplate, layerOpts);
  }

  window.OfflineTileLayer = OfflineTileLayer;
  window.createOfflineLayer = createOfflineLayer;
  window.loadPackManifest = loadPackManifest;
  window.getOfflinePack = function () { return pack; };
})();
