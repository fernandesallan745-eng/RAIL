/* ═══════════════════════════════════════════════════════════════════════════════
   GATI ADMIN — operator console behaviour.

   LOADS AFTER app.js AND READS ITS GLOBALS BY BARE NAME.

   app.js is a classic script: its top-level `let map`, `let tunnelsLayer`, … live in
   the shared global lexical environment, so this file can read them directly. It must
   never RE-DECLARE any of them — a second `let map` in the same scope is a
   SyntaxError, not a shadow, and would take the whole page down. Everything below is
   wrapped in an IIFE for exactly that reason: nothing here reaches global scope.

   It also never re-implements app.js's arithmetic. The corridor row delegates to
   toggleCorridorLayer(), the train selection delegates to selectTrain(), and every
   model number is rendered as received. Two copies of a calculation are two
   calculations that will eventually disagree — the same discipline the tunnel and
   conflict layers already follow.

   UPSTREAM COST: zero, except the one button that says otherwise on its face.
   /api/model/* and /api/corridor/conflicts are cache-only on the model side;
   /api/health is local. Only "Force-refresh train" sends ?refresh=true, and it is
   labelled "spends 1 upstream request" in the markup.
   ═══════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── Small helpers ───────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /** Fixed-decimal format that renders a missing number as an em dash, never as 0. */
  const fmt = (n, d = 1) =>
    (typeof n === 'number' && Number.isFinite(n)) ? n.toFixed(d) : '—';

  /** Signed format, for contribution rows where the sign carries the meaning. */
  const signed = (n, d = 1) => {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(d);
  };

  const clockOf = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? null
      : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  // ── Map layer switchboard ───────────────────────────────────────────────────
  //
  // Each spec resolves its Leaflet group LAZILY. The groups are assigned inside
  // initMap(), which runs in bootstrapApp() — async — so they are still null when
  // this file first executes. Deferring the lookup into a function means the panel
  // reads whatever exists at render time, and a ReferenceError (app.js absent) is
  // caught per-row rather than blanking the whole panel.
  const LAYER_SPECS = [
    { key: 'fleet',    label: 'Fleet positions', get: () => fleetMarkersLayer },
    { key: 'route',    label: 'Route polyline',  get: () => activeRouteLayer },
    { key: 'stations', label: 'Stations',        get: () => activeStationsLayer },
    { key: 'tunnels',  label: 'Tunnels',         get: () => tunnelsLayer },
    { key: 'conflict', label: 'Crossings (this train)', get: () => conflictLayer },
    // A TileLayer, not a LayerGroup — it has no getLayers(), so its count shows "—"
    // rather than a fabricated 0. Included because it is a genuinely toggleable
    // overlay (OpenRailwayMap track lines) an operator may want off.
    { key: 'railway',  label: 'Railway track overlay', get: () => railwayLayer },
    {
      key: 'corridor',
      label: 'Crossings (corridor-wide)',
      get: () => corridorConflictLayer,
      // Delegated, not duplicated: toggleCorridorLayer() also owns the ⇄ button's
      // aria-pressed state, the legend and the lazy fetch. Calling map.addLayer here
      // instead would let the checkbox, the button and the legend disagree.
      delegate: () => toggleCorridorLayer(),
    },
  ];

  const resolveLayer = (spec) => {
    try {
      return spec.get() || null;
    } catch (_) {
      return null;   // app.js never loaded — the row renders as unavailable
    }
  };

  /** Feature count on a layer group, or null when the group does not exist yet. */
  const featureCount = (layer) => {
    if (!layer || typeof layer.getLayers !== 'function') return null;
    try {
      return layer.getLayers().length;
    } catch (_) {
      return null;
    }
  };

  function buildMapLayerRows() {
    const host = $('mapLayersBody');
    if (!host) return;

    host.innerHTML = LAYER_SPECS.map((spec) => `
      <label class="admin-row" data-layer="${esc(spec.key)}">
        <input type="checkbox" id="lyr-${esc(spec.key)}" />
        <span class="admin-row-label">${esc(spec.label)}</span>
        <span class="admin-row-count" id="lyrCount-${esc(spec.key)}">—</span>
      </label>
    `).join('');

    for (const spec of LAYER_SPECS) {
      const box = $(`lyr-${spec.key}`);
      if (!box) continue;
      box.addEventListener('change', () => {
        const layer = resolveLayer(spec);
        if (!layer || typeof map === 'undefined' || !map) {
          box.checked = false;
          return;
        }
        if (spec.delegate) {
          // Let the owner flip it, then re-sync from the map's real state rather
          // than assuming the delegate did what we expected.
          Promise.resolve(spec.delegate())
            .catch((e) => console.error('[admin] corridor toggle failed:', e))
            .finally(syncMapLayerPanel);
          return;
        }
        if (box.checked) map.addLayer(layer);
        else map.removeLayer(layer);
        syncMapLayerPanel();
      });
    }
  }

  /**
   * Re-read the map's actual state into the panel.
   *
   * The checkbox reflects `map.hasLayer()`, never a variable this file keeps — the ⇄
   * button and the legend's × can both turn the corridor layer off behind our back,
   * and a panel that tracked its own idea of the state would quietly drift out of
   * agreement with the map it is describing.
   */
  function syncMapLayerPanel() {
    let live = 0;
    let total = 0;

    for (const spec of LAYER_SPECS) {
      const box = $(`lyr-${spec.key}`);
      const countEl = $(`lyrCount-${spec.key}`);
      const row = box ? box.closest('.admin-row') : null;
      if (!box || !countEl) continue;

      const layer = resolveLayer(spec);
      const hasMap = typeof map !== 'undefined' && map;

      if (!layer || !hasMap) {
        box.checked = false;
        box.disabled = true;
        countEl.textContent = 'n/a';
        countEl.classList.add('is-zero');
        if (row) row.classList.add('is-missing');
        continue;
      }

      box.disabled = false;
      if (row) row.classList.remove('is-missing');
      const on = map.hasLayer(layer);
      box.checked = on;
      total += 1;
      if (on) live += 1;

      const n = featureCount(layer);
      countEl.textContent = n == null ? '—' : String(n);
      countEl.classList.toggle('is-zero', n === 0);
    }

    const meta = $('mapLayersMeta');
    if (meta) meta.textContent = `${live}/${total} on`;
  }

  // ── Upstream quota & posture ────────────────────────────────────────────────
  //
  // Everything rendered here comes from getDiagnostics() via /api/health, which
  // returns counts, indices and config only — never a key value. Nothing in this
  // function may add one.
  async function refreshQuota() {
    const host = $('quotaBody');
    const meta = $('quotaMeta');
    if (!host) return;

    let health;
    try {
      const res = await fetch(apiUrl('/api/health'));
      health = await res.json();
    } catch (err) {
      host.innerHTML = `<div class="admin-empty">Gateway unreachable — ${esc(err.message)}</div>`;
      if (meta) meta.textContent = 'offline';
      return;
    }

    const up = health?.upstream;
    if (!up || up.unavailable) {
      // Named, not blank: "no diagnostics" and "zero usage" are different facts.
      // train.controller.js deliberately returns {unavailable, reason} rather than
      // throwing, because /health is the endpoint an operator hits when things are
      // already broken — so reproduce its reason instead of flattening it to 0.
      host.innerHTML = `<div class="admin-empty">Upstream diagnostics unavailable —
        quota state is <strong>unknown, not zero</strong>.
        ${up?.reason ? `<br/>Reason: <code>${esc(up.reason)}</code>` : ''}</div>`;
      if (meta) meta.textContent = 'unknown';
      return;
    }

    const q = up.quota || {};
    const rw = up.rateWindow || {};
    const rl = up.rateLimit || {};
    const fl = up.fleet || {};
    const cp = up.cachePolicy || {};
    const perKey = Array.isArray(q.perKey) ? q.perKey : [];
    const monthly = q.monthlyPerKey || 0;

    const keyRows = perKey.map((k) => {
      const used = k.used || 0;
      const pct = monthly > 0 ? Math.min(100, (used / monthly) * 100) : 0;
      const cls = pct >= 100 ? 'is-bad' : pct >= 80 ? 'is-warn' : 'is-good';
      return `
        <div class="admin-kv">
          <span class="admin-kv-key">key #${esc(k.index)}${k.index === up.activeKeyIndex ? ' (active)' : ''}</span>
          <span class="admin-kv-val ${cls}">${used} / ${monthly}</span>
        </div>
        <div class="admin-quota-bar"><div class="admin-quota-fill ${cls}" style="width:${pct.toFixed(1)}%"></div></div>`;
    }).join('');

    const windowCls = (rw.remainingInWindow || 0) === 0 ? 'is-bad'
      : (rw.remainingInWindow || 0) <= 2 ? 'is-warn' : 'is-good';

    host.innerHTML = `
      ${keyRows || '<div class="admin-empty">No API keys configured.</div>'}
      <div class="admin-kv">
        <span class="admin-kv-key">rate window</span>
        <span class="admin-kv-val ${windowCls}">${rw.usedInWindow ?? '—'} / ${rw.perMinute ?? '—'} per ${rw.windowSeconds ?? 60}s</span>
      </div>
      <div class="admin-kv">
        <span class="admin-kv-key">throttled</span>
        <span class="admin-kv-val">${rw.throttledMs ? `${rw.throttledMs} ms` : 'no'}</span>
      </div>
      <div class="admin-kv">
        <span class="admin-kv-key">429s since boot</span>
        <span class="admin-kv-val ${(rl.count429 || 0) > 0 ? 'is-warn' : ''}">${rl.count429 ?? 0}</span>
      </div>
      <div class="admin-kv">
        <span class="admin-kv-key">in flight / queued</span>
        <span class="admin-kv-val">${up.upstream?.inFlight ?? '—'} / ${up.upstream?.queued ?? '—'}</span>
      </div>
      <div class="admin-kv">
        <span class="admin-kv-key">total since boot</span>
        <span class="admin-kv-val">${up.upstream?.totalRequests ?? '—'}</span>
      </div>
      <div class="admin-kv">
        <span class="admin-kv-key">fleet polled</span>
        <span class="admin-kv-val">${(fl.trains || []).length} / ${fl.maxTrains ?? '—'}</span>
      </div>
      <div class="admin-kv">
        <span class="admin-kv-key">live cache</span>
        <span class="admin-kv-val">${cp.liveCachingDisabled ? 'off (every poll is live)' : `${cp.liveTtlSeconds}s`}</span>
      </div>
      <div class="admin-kv">
        <span class="admin-kv-key">gateway cache keys</span>
        <span class="admin-kv-val">${health?.cache?.cachedKeysCount ?? '—'}</span>
      </div>
      <p class="admin-note">
        Key <strong>indices</strong> only — no key value is ever sent to the browser.
        Fleet size <strong>is</strong> the per-poll request count while live caching is
        off, so each train added costs another upstream request per tick.
      </p>`;

    if (meta) {
      meta.textContent = q.exhausted
        ? 'quota spent'
        : `${q.totalRemaining ?? '—'} left this month`;
    }
  }

  // ── ETA layer ladder ────────────────────────────────────────────────────────
  let lastEtaTrain = null;
  let lastQuery = null;

  /**
   * The Model-query panel header states the parameters the ladder below was
   * actually computed with — and flags when the selectors have since moved but
   * the model has not been re-run. Without the stale marker the header would
   * describe a query whose result is not on screen, which is worse than the
   * bare "—" it replaces.
   */
  function syncQueryMeta() {
    const meta = $('queryMeta');
    if (!meta) return;
    if (!lastQuery) { meta.textContent = 'not run'; return; }

    const bits = [lastQuery.mode];
    if (lastQuery.weather && lastQuery.weather !== 'clear') bits.push(lastQuery.weather);
    if (lastQuery.date) bits.push(lastQuery.date);

    const drifted =
      ($('qTrain')?.value || '').trim() !== lastQuery.train ||
      ($('qDate')?.value || '') !== lastQuery.date ||
      ($('qWeather')?.value || 'clear') !== lastQuery.weather ||
      ($('qMode')?.value || 'vertex') !== lastQuery.mode;

    meta.textContent = `${bits.join(' · ')}${drifted ? ' · stale' : ''}`;
    meta.title = drifted
      ? 'The selectors have changed since this result was computed — press Run model.'
      : 'Parameters this result was computed with.';
  }

  /** Horizontal bar for one contribution, scaled against the largest in the ladder. */
  const bar = (value, scale) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) {
      return '<div class="ladder-bar"></div>';
    }
    // A layer worth 0.0013 min still renders a visible sliver (CSS min-width: 2px).
    // "Too small to see" is the finding about curvature on this route — a row that
    // vanished entirely would read as a layer that is not wired up.
    const pct = scale > 0 ? Math.min(50, (Math.abs(value) / scale) * 50) : 0;
    const dir = value > 0 ? 'adds' : 'saves';
    return `<div class="ladder-bar"><span class="${dir}" style="width:${pct.toFixed(2)}%"></span></div>`;
  };

  const ladderRow = (label, value, scale, extra = '') => {
    const cls = typeof value !== 'number' || !Number.isFinite(value) || value === 0
      ? 'nil' : (value > 0 ? 'adds' : 'saves');
    const decimals = (typeof value === 'number' && value !== 0 && Math.abs(value) < 0.1) ? 4 : 1;
    return `
      <div class="ladder-row">
        <span class="ladder-label">${label}${extra}</span>
        <span class="ladder-value ${cls}">${signed(value, decimals)}</span>
        ${bar(value, scale)}
      </div>`;
  };

  function renderEta(d) {
    const host = $('etaBody');
    const meta = $('etaMeta');
    if (!host) return;

    const t = d.totals || {};
    const weather = d.weather || 'clear';
    const isClear = weather === 'clear';

    // Layer decomposition. curvature_layer_contribution_min is the physics layer's
    // own cost; the remainder of running_min over the naive flat-speed baseline is
    // the schedule-derived speeds. Reported separately because they differ by five
    // orders of magnitude on this route and lumping them together would credit
    // curvature with accuracy it did not produce.
    const naive = t.naive_flat_speed_min;
    const curve = d.curvature_layer_contribution_min;
    const running = t.running_min;
    const baseline = (typeof running === 'number' && typeof naive === 'number')
      ? running - naive - (typeof curve === 'number' ? curve : 0)
      : null;
    const delay = t.historical_delay_min;
    const dwell = t.dwell_min;
    const holds = t.conflict_hold_min;
    const total = t.predicted_eta_min;

    const contributions = [baseline, curve, delay, dwell, holds]
      .filter((v) => typeof v === 'number' && Number.isFinite(v));
    const scale = Math.max(...contributions.map(Math.abs), 1);

    // Independent reconciliation of the ladder against the model's own total. If the
    // rows do not sum to predicted_eta_min the panel says so rather than displaying a
    // breakdown that silently fails to add up.
    const ladderSum = (typeof naive === 'number' ? naive : 0)
      + contributions.reduce((a, b) => a + b, 0);
    const residual = (typeof total === 'number') ? ladderSum - total : null;
    const reconciles = residual !== null && Math.abs(residual) < 0.05;

    // Phase 8 honesty wiring: under non-clear weather the curvature penalty has the
    // weather factor folded into it, so it is NOT curvature alone and must not be
    // labelled as though it were.
    const curveLabel = isClear ? 'curvature' : 'curvature + weather';

    const gr = d.geometry_resolution || {};
    const band = d.observed_band || {};
    const audit = d.historical_delay_audit || {};
    const cl = d.conflict_layer || {};
    const asm = cl.assumptions || {};

    // ── Observed band ─────────────────────────────────────────────────────────
    let bandHtml;
    if (band.available && typeof band.band_low_min === 'number') {
      const lo = band.band_low_min;
      const hi = band.band_high_min;
      const span = hi - lo || 1;
      const centrePct = ((band.centre_min - lo) / span) * 100;
      const arrEarly = clockOf(d.predicted_arrival_earliest);
      const arrLate = clockOf(d.predicted_arrival_latest);
      bandHtml = `
        <div class="band-wrap">
          <div class="band-head">
            <span>Observed band</span>
            <span class="band-pm">${fmt(band.centre_min)} −${fmt(band.minus_min)}/+${fmt(band.plus_min)} min</span>
          </div>
          <div class="band-track">
            <div class="band-span" style="left:0;right:0"></div>
            <div class="band-centre" style="left:${centrePct.toFixed(1)}%"></div>
          </div>
          <div class="band-note">
            ${fmt(lo)}–${fmt(hi)} min${arrEarly && arrLate ? ` &nbsp;·&nbsp; ${esc(arrEarly)}–${esc(arrLate)}` : ''}
            &nbsp;·&nbsp; <strong>n=${band.sample_count}</strong> observed runs,
            spread ${fmt(band.observed_spread_min, 0)} min about a mean of
            ${fmt(band.observed_mean_min)}.
            <br/><em>Not a confidence interval</em> — n is far too small for a
            meaningful sigma. The width is the measured spread; the centre is the
            model's own prediction, so the band does not re-centre the evidence on
            the model.
          </div>
        </div>`;
    } else {
      // The silent-zero case. "No spread" and "spread unknown" are opposite facts
      // and must never render the same way (VERIFIED #9). Prefer the model's own
      // note — it is the authority on why — and fall back to our own wording only
      // when it gives none, so the two are never printed on top of each other.
      bandHtml = `
        <div class="band-wrap">
          <div class="band-head"><span>Observed band</span><span class="band-pm">unavailable</span></div>
          <div class="band-note">
            ${band.note
              ? esc(band.note)
              : 'No observed runs are cached for this train, so the spread is '
                + '<strong>unknown, not zero</strong>.'}
            ${band.unavailable_reason ? `<br/>Reason: <code>${esc(band.unavailable_reason)}</code>` : ''}
          </div>
        </div>`;
    }

    // ── Per-date delay samples ────────────────────────────────────────────────
    const samples = audit.end_to_end_delay_samples || {};
    const dates = Object.keys(samples);
    const maxAbs = Math.max(...dates.map((k) => Math.abs(samples[k] || 0)), 1);
    const delayRows = dates.map((k) => {
      const v = samples[k];
      const dir = v > 0 ? 'late' : 'early';
      const pct = Math.min(50, (Math.abs(v) / maxAbs) * 50);
      return `
        <div class="delay-row">
          <span class="delay-date">${esc(k)}</span>
          <div class="delay-bar"><span class="${dir}" style="width:${pct.toFixed(1)}%"></span></div>
          <span class="delay-val ${dir}">${signed(v, 0)}</span>
        </div>`;
    }).join('');

    // ── Curvature resolvability ───────────────────────────────────────────────
    const resolvable = typeof gr.resolvable_pct === 'number' ? gr.resolvable_pct : null;
    const blindHtml = resolvable === null ? '' : `
      <div class="blind-track">
        <div class="blind-resolvable" style="width:${resolvable.toFixed(1)}%"></div>
        <div class="blind-dark" style="width:${(100 - resolvable).toFixed(1)}%"></div>
      </div>
      <div class="blind-legend">
        <span><span class="blind-key resolvable"></span>resolvable ${fmt(resolvable)}%</span>
        <span><span class="blind-key dark"></span>curvature-blind ${fmt(gr.curvature_blind_pct)}%</span>
      </div>`;

    const chips = [
      d.curvature_mode ? `mode <strong>${esc(d.curvature_mode)}</strong>` : null,
      d.geometry_basis ? `geometry <strong>${esc(d.geometry_basis)}</strong>` : null,
      `weather <strong>${esc(weather)}</strong>`,
      asm.loopDataIsOfficial === false ? 'loop data <strong>assumed</strong>' : null,
      asm.priorityIsOfficial === false ? 'precedence <strong>heuristic</strong>' : null,
      d.schedule_date_substituted ? `schedule from <strong>${esc(d.schedule_source_date)}</strong>` : null,
    ].filter(Boolean);

    const arr = clockOf(d.predicted_arrival);
    const schedArr = clockOf(d.scheduled_arrival);

    host.innerHTML = `
      <div class="admin-ladder">
        <div class="ladder-row is-base">
          <span class="ladder-label">Naive flat ${fmt(d.max_speed_kmh, 0)} km/h</span>
          <span class="ladder-value">${fmt(naive)}</span>
          <div class="ladder-bar"></div>
        </div>
        ${ladderRow('+ schedule baseline speeds', baseline, scale)}
        ${ladderRow(`+ ${esc(curveLabel)}`, curve, scale)}
        ${ladderRow('+ historical delay', delay, scale)}
        ${ladderRow('+ halt dwell', dwell, scale)}
        ${ladderRow('+ conflict holds', holds, scale)}
      </div>

      <div class="ladder-total">
        <span class="ladder-total-label">Predicted</span>
        <span>
          <span class="ladder-total-value">${fmt(total)}</span>
          <span class="ladder-total-unit">min${arr ? ` · arr ${esc(arr)}` : ''}</span>
        </span>
      </div>

      <div class="admin-kv" style="margin-top:6px">
        <span class="admin-kv-key">vs timetable (${fmt(t.scheduled_duration_min, 0)} min${schedArr ? `, arr ${esc(schedArr)}` : ''})</span>
        <span class="admin-kv-val ${t.gap_vs_schedule_min < 0 ? 'is-good' : ''}">${signed(t.gap_vs_schedule_min)} min</span>
      </div>
      ${typeof band.error_vs_observed_mean_min === 'number' ? `
      <div class="admin-kv">
        <span class="admin-kv-key">vs observed mean (n=${band.sample_count})</span>
        <span class="admin-kv-val">${signed(band.error_vs_observed_mean_min)} min</span>
      </div>` : ''}
      ${!reconciles ? `
      <div class="admin-op-result is-bad" style="margin-top:6px">
        Ladder does not reconcile: rows sum to ${fmt(ladderSum, 3)}, model reports
        ${fmt(total, 3)} (residual ${signed(residual, 3)}). Treat the breakdown as suspect.
      </div>` : ''}

      ${bandHtml}

      <details class="admin-caveat">
        <summary>Curvature — measured over the resolvable ${fmt(resolvable)}% only ▾</summary>
        <div class="admin-caveat-body">
          ${blindHtml}
          Curvature contributes <strong>${signed(curve, 4)} min</strong> here, over
          <strong>${fmt(d.curvature_layer_covers_km, 0)} km</strong> with geometry
          (<code>${esc(d.geometry_basis || 'none')}</code>).
          Vertex spacing is median ${esc(gr.spacing_m?.median ?? '—')} m but reaches
          ${esc(gr.spacing_m?.max ?? '—')} m, and a 3-point circumradius cannot resolve
          a curve shorter than its own chord — so in the blind
          ${fmt(gr.curvature_blind_pct)}% curvature is <strong>undetectable, not
          absent</strong>. Never present this as a route-wide measurement.
          ${d.geometry_basis === 'shared-corridor-polyline' ? '<br/>This train has no '
            + 'route file of its own: the alignment is the real Konkan polyline clipped '
            + 'to its km span, which is the right geometry but not that train\'s own.' : ''}
        </div>
      </details>

      <details class="admin-caveat">
        <summary>Historical delay — ${dates.length ? `n=${dates.length} dated runs` : 'no dated runs'} ▾</summary>
        <div class="admin-caveat-body">
          ${dates.length ? `
            <div class="delay-grid">${delayRows}</div>
            <div style="margin-top:6px">
              End-to-end mean <strong>${signed(audit.end_to_end_delay_mean_min)} min</strong>
              over <strong>n=${dates.length}</strong> runs; per-segment increments sum to
              ${signed(audit.segment_increments_sum_min)}.
              ${typeof audit.coverage_artifact_min === 'number' && Math.abs(audit.coverage_artifact_min) > 0.05 ? `
              The <strong>${signed(audit.coverage_artifact_min)} min</strong> difference is a
              sample-coverage artifact, not an error: halts observed on fewer dates make a
              sum-of-means diverge from a mean-of-sums. Quote the end-to-end mean as the
              measured average; the increments show <em>where</em> delay accrues.` : ''}
              <br/>Zero-echo dates are <strong>skipped, not averaged in as zeros</strong> —
              a completed-but-untracked run reports 0, and counting that as "on time" would
              drag the mean toward nothing.
            </div>` : `
            No dated runs with a real delay signal are cached for this train, so the delay
            layer contributes <strong>0.0 by absence of evidence</strong> — not because the
            train runs to time.`}
        </div>
      </details>

      <details class="admin-caveat">
        <summary>Crossings — ${cl.enabled ? `${cl.conflict_count ?? 0} predicted, ${cl.held_count ?? 0} held` : 'layer off'} ▾</summary>
        <div class="admin-caveat-body">
          ${cl.error ? `Layer error: <code>${esc(cl.error)}</code>` : `
            Hold total <strong>${fmt(cl.total_hold_min)} min</strong> at a
            ${fmt(cl.delay_min_applied)} min applied delay.
            ${esc(cl.note || '')}
            <br/>Loop locations are <strong>assumed</strong> at every timetable station on
            the single-line section (<code>${esc(asm.loopBasis || 'n/a')}</code>); this
            source carries no track-count data. Precedence is a heuristic over train type,
            not Indian Railways rules — the real call is a Section Controller's.
            Other trains' times are <strong>scheduled</strong>; only our delay is live.
            Re-acceleration constant <code>${fmt(asm.reaccelMin)} min</code>.
            Prediction only — nothing is dispatched.`}
        </div>
      </details>

      <div class="admin-chips">${chips.map((c) => `<span class="admin-chip">${c}</span>`).join('')}</div>`;

    if (meta) meta.textContent = `${esc(d.train)} · ${fmt(total)} min`;
  }

  async function loadEta(trainNumber, opts = {}) {
    const host = $('etaBody');
    const meta = $('etaMeta');
    if (!host || !trainNumber) return;

    host.innerHTML = '<div class="admin-empty">Running model…</div>';
    if (meta) meta.textContent = 'running…';

    const params = new URLSearchParams();
    const date = opts.date ?? ($('qDate')?.value || '');
    const weather = opts.weather ?? ($('qWeather')?.value || 'clear');
    const mode = opts.mode ?? ($('qMode')?.value || 'vertex');
    if (date) params.set('date', date);
    if (weather) params.set('weather', weather);
    if (mode) params.set('mode', mode);

    // Record what this run was actually computed WITH, so the ladder below can
    // never be misread as belonging to different parameters — a 718.2 under
    // heavy_rain and a 612.8 under clear are both correct and look alike.
    lastQuery = { train: String(trainNumber), date, weather, mode };
    syncQueryMeta();

    try {
      const res = await fetch(apiUrl(`/api/model/eta/${encodeURIComponent(trainNumber)}?${params}`));
      const json = await res.json();

      if (!res.ok || json.success === false) {
        // Each failure names itself. A 503 and an empty result look identical on
        // screen and mean opposite things.
        const reason = json.reason || `http-${res.status}`;
        host.innerHTML = `
          <div class="admin-op-result is-bad">
            ${esc(reason)}
            ${json.detail ? `\n${esc(typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail))}` : ''}
            ${json.hint ? `\n→ ${esc(json.hint)}` : ''}
          </div>`;
        if (meta) meta.textContent = esc(reason);
        return;
      }

      lastEtaTrain = String(trainNumber);
      renderEta(json.data);
    } catch (err) {
      host.innerHTML = `<div class="admin-op-result is-bad">Request failed: ${esc(err.message)}</div>`;
      if (meta) meta.textContent = 'failed';
    }
  }

  // ── Controls ────────────────────────────────────────────────────────────────
  function wireControls() {
    // Weather placeholder warning: shown only when the untuned multipliers are
    // actually in play. Required Phase 8 honesty wiring.
    const wx = $('qWeather');
    const warn = $('qWeatherWarn');
    const syncWxWarn = () => { if (warn) warn.hidden = !wx || wx.value === 'clear'; };
    if (wx) wx.addEventListener('change', syncWxWarn);
    syncWxWarn();

    // Any selector moving makes the on-screen ladder stale until Run is pressed.
    ['qTrain', 'qDate', 'qWeather', 'qMode'].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('change', syncQueryMeta);
      el.addEventListener('input', syncQueryMeta);
    });
    syncQueryMeta();

    $('qRun')?.addEventListener('click', () => {
      const n = ($('qTrain')?.value || '').trim();
      if (!n) {
        const host = $('etaBody');
        if (host) host.innerHTML = '<div class="admin-empty">Enter a train number first.</div>';
        return;
      }
      loadEta(n);
    });

    $('qTrain')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('qRun')?.click();
    });

    // Corridor sweep — cache-only on the model side, zero upstream requests.
    $('cRun')?.addEventListener('click', async () => {
      const btn = $('cRun');
      const out = $('cResult');
      if (!out) return;
      const params = new URLSearchParams();
      const put = (id, key) => {
        const v = ($(id)?.value || '').trim();
        if (v) params.set(key, v);
      };
      put('cDate', 'date');
      put('cAt', 'at');
      put('cWindow', 'window');
      put('cLimit', 'limit');
      put('cDelay', 'delay');

      out.hidden = false;
      out.className = 'admin-op-result';
      out.textContent = 'Running corridor sweep…';
      if (btn) btn.disabled = true;

      try {
        const res = await fetch(apiUrl(`/api/corridor/conflicts?${params}`));
        const json = await res.json();
        if (!res.ok || json.success === false) {
          out.className = 'admin-op-result is-bad';
          out.textContent = `${json.reason || `http-${res.status}`}`
            + `${json.hint ? `\n→ ${json.hint}` : ''}`;
          return;
        }
        const d = json.data || {};
        const meets = Array.isArray(d.meets) ? d.meets : [];
        const drawable = meets.filter((m) => m.lat != null && m.lng != null).length;
        const overtakes = meets.filter((m) => m.kind === 'overtake' || m.type === 'overtake').length;
        out.className = 'admin-op-result is-ok';
        // Undrawable meets are COUNTED, never silently dropped — they are the ones
        // south of MAO where no cached polyline exists yet.
        out.textContent =
          `service date ${d.serviceDate || d.date || '—'}\n`
          + `${meets.length} unique meets · ${overtakes} overtake / ${meets.length - overtakes} head-on\n`
          + `${drawable} drawable (${meets.length ? ((drawable / meets.length) * 100).toFixed(1) : '0'}%), `
          + `${meets.length - drawable} without geometry\n`
          + `positionBasis: scheduled · 0 upstream requests`;

        // Refresh the layer counts: the sweep may have populated the corridor layer.
        syncMapLayerPanel();
      } catch (err) {
        out.className = 'admin-op-result is-bad';
        out.textContent = `Request failed: ${err.message}`;
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    // ── Ops ───────────────────────────────────────────────────────────────────
    // The ONE control on this page that spends upstream quota. It says so on its
    // face and confirms before firing: "nothing that touches quota unexpectedly"
    // means unexpectedly, not never.
    $('opRefreshTrain')?.addEventListener('click', async () => {
      const n = ($('qTrain')?.value || '').trim()
        || (typeof selectedTrainNumber !== 'undefined' ? selectedTrainNumber : '');
      const out = $('opResult');
      if (!out) return;
      if (!n) {
        out.hidden = false;
        out.className = 'admin-op-result is-bad';
        out.textContent = 'Select or enter a train first.';
        return;
      }
      if (!window.confirm(
        `Force-refresh train ${n}?\n\n`
        + 'This bypasses the gateway cache and sends a live request to RailRadar, '
        + 'spending 1 of the 1,000 requests in this month\'s free tier.')) {
        return;
      }
      out.hidden = false;
      out.className = 'admin-op-result';
      out.textContent = `Refreshing ${n} from upstream…`;
      try {
        // Delegated to app.js: it owns the drawer, the polyline, the tunnel and
        // conflict panels. Re-implementing the fetch here would give the page two
        // code paths for one action.
        await selectTrain(n, true, true);
        out.className = 'admin-op-result is-ok';
        out.textContent = `Refreshed ${n} from upstream (1 request spent).`;
        await refreshQuota();
        syncMapLayerPanel();
      } catch (err) {
        out.className = 'admin-op-result is-bad';
        out.textContent = `Refresh failed: ${err.message}`;
      }
    });

    $('opFlushCache')?.addEventListener('click', async () => {
      const out = $('opResult');
      if (!out) return;
      if (!window.confirm(
        'Flush the gateway\'s in-memory cache?\n\n'
        + 'This clears cached route polylines, schedules and the corridor sweep held by '
        + 'this Node process. The .cache/ corpus on disk is NOT touched.\n\n'
        + 'The next request for each static resource will re-fetch and spend an upstream '
        + 'request.')) {
        return;
      }
      out.hidden = false;
      out.className = 'admin-op-result';
      out.textContent = 'Flushing…';
      try {
        const res = await fetch(apiUrl('/api/admin/cache/flush'), { method: 'POST' });
        const json = await res.json();
        if (!res.ok || json.success === false) {
          out.className = 'admin-op-result is-bad';
          out.textContent = json.reason || `http-${res.status}`;
          return;
        }
        out.className = 'admin-op-result is-ok';
        // Before/after counts, not a claim that it worked.
        out.textContent =
          `${json.scope}\n`
          + `keys ${json.keysBefore} → ${json.keysAfter} (${json.keysCleared} cleared)\n`
          + `disk .cache/ touched: ${json.diskCacheTouched ? 'YES' : 'no'}`;
      } catch (err) {
        out.className = 'admin-op-result is-bad';
        out.textContent = `Flush failed: ${err.message}`;
      }
    });
  }

  // ── Drawer collision ────────────────────────────────────────────────────────
  //
  // The drawer occupies left: 20px, width: 440px — exactly where the left rail sits.
  // Mirror its open state onto <body> so CSS can slide the rail clear. A
  // MutationObserver rather than :has() so the behaviour does not depend on selector
  // support, and rather than patching app.js's drawer functions, which would couple
  // the two files.
  function watchDrawer() {
    const drawer = $('trainDrawer');
    if (!drawer) return;
    const sync = () => {
      document.body.classList.toggle('admin-drawer-open', drawer.classList.contains('open'));
    };
    new MutationObserver(sync).observe(drawer, { attributes: true, attributeFilter: ['class'] });
    sync();
  }

  // ── Follow the map's selection ──────────────────────────────────────────────
  //
  // selectedTrainNumber is app.js's own state. Poll it rather than wrapping
  // selectTrain(): app.js reassigns it from several paths (search, marker click,
  // auto-refresh) and a wrapper would have to intercept each one.
  function watchSelection() {
    let seen = null;
    setInterval(() => {
      let current = null;
      try {
        current = typeof selectedTrainNumber !== 'undefined' ? selectedTrainNumber : null;
      } catch (_) { /* app.js absent */ }
      if (current && current !== seen) {
        seen = current;
        const input = $('qTrain');
        if (input) input.value = current;
        if (String(current) !== lastEtaTrain) loadEta(current);
      }
      syncMapLayerPanel();
    }, 1500);
  }

  // ── Boot ────────────────────────────────────────────────────────────────────
  //
  // Waits for app.js's `gati:ready`, dispatched at the end of bootstrapApp(). That
  // function is async (it awaits loadPackManifest), so `map` and every layer group
  // are still null when this file executes — polling or racing would read nulls.
  function start() {
    buildMapLayerRows();
    syncMapLayerPanel();
    wireControls();
    watchDrawer();
    watchSelection();
    refreshQuota();
    setInterval(refreshQuota, 15000);   // local call to our own gateway; costs nothing upstream

    // Seed the ETA panel with the reference demo train so the page is never empty
    // on first load.
    const input = $('qTrain');
    const seed = (typeof selectedTrainNumber !== 'undefined' && selectedTrainNumber) || '22229';
    if (input && !input.value) input.value = seed;
    loadEta(seed);
  }

  if (document.readyState !== 'loading' && typeof map !== 'undefined' && map) {
    start();                                        // already booted (cached reload)
  } else {
    document.addEventListener('gati:ready', start, { once: true });
    // Fallback: if app.js never reaches the end of bootstrapApp (e.g. the native
    // setup card is showing instead), still bring up the panels that do not need a
    // map, rather than leaving the console blank with no explanation.
    setTimeout(() => {
      if (!$('mapLayersBody')?.children.length) start();
    }, 4000);
  }
})();
