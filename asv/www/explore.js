'use strict';

/* The "explore" view of an asv site: an overview of what changed, and a
   graph page that overlays benchmarks, shows the confidence interval of
   each result and lists the changes that exceed the noise.  It reads the
   same files as the classic view (index.json, graphs/), plus details/
   (confidence intervals) and changes.json written by `asv publish`. */

(function () {
    // ------------------------------------------------------------------
    // Small DOM helpers.  Text always goes in through textContent.

    function el(tag, attrs, ...children) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(attrs || {})) {
            if (value === null || value === undefined || value === false) continue;
            if (key === 'class') node.className = value;
            else if (key === 'text') node.textContent = value;
            else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
            else if (key === 'style') Object.assign(node.style, value);
            else node.setAttribute(key, value === true ? '' : value);
        }
        for (const child of children.flat()) {
            if (child === null || child === undefined || child === false) continue;
            node.append(child instanceof Node ? child : document.createTextNode(String(child)));
        }
        return node;
    }

    function cssVar(name) {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }

    function withAlpha(hex, alpha) {
        const m = /^#([0-9a-f]{6})$/i.exec(hex);
        if (!m) return hex;
        const n = parseInt(m[1], 16);
        return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
    }

    // ------------------------------------------------------------------
    // Loading

    const cache = new Map();
    let timestamp = '';

    function loadJSON(url, optional) {
        if (!cache.has(url)) {
            const request = fetch(url + '?timestamp=' + encodeURIComponent(timestamp))
                .then(response => {
                    if (response.ok) return response.json();
                    if (optional) return null;
                    throw new Error(`${url}: ${response.status}`);
                })
                .catch(err => {
                    if (optional) return null;
                    throw err;
                });
            cache.set(url, request);
        }
        return cache.get(url);
    }

    /* Must match asv.util.sanitize_filename */
    function sanitizeFilename(name) {
        const bad = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5',
                     'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4',
                     'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'];
        name = name.replace(/[<>:"\/\\^|?*\x00-\x1f]/g, '_');
        if (bad.includes(name.toUpperCase())) name += '_';
        return name;
    }

    /* Must match asv.graph.Graph.get_file_path (root 'details' for
       Graph.detail_path) */
    function graphPath(benchmark, params, root) {
        const parts = Object.entries(params).map(([key, value]) => {
            if (value === null) return sanitizeFilename(key + '-null');
            if (value) return sanitizeFilename(key + '-' + value);
            return sanitizeFilename(key);
        });
        parts.sort();
        return [root || 'graphs', ...parts, sanitizeFilename(benchmark)]
            .map(encodeURIComponent).join('/') + '.json';
    }

    // ------------------------------------------------------------------
    // Formatting

    const TIME_UNITS = [['ns', 1e-9], ['µs', 1e-6], ['ms', 1e-3], ['s', 1], ['min', 60], ['h', 3600]];
    const BYTE_UNITS = [['B', 1], ['kB', 1e3], ['MB', 1e6], ['GB', 1e9], ['TB', 1e12]];

    /* A display scale for values of `unit` around `magnitude` */
    function unitScale(unit, magnitude) {
        const m = Math.abs(magnitude) || 1;
        let table = null;
        if (unit === 'seconds') table = TIME_UNITS;
        else if (unit === 'bytes') table = BYTE_UNITS;
        if (table) {
            let chosen = table[0];
            for (const entry of table) {
                if (m >= entry[1] * 0.95) chosen = entry;
            }
            return { div: chosen[1], suffix: chosen[0], name: chosen[0] };
        }
        const name = unit && unit !== 'unit' ? unit.replace(/_/g, ' ') : '';
        if (m >= 1e9) return { div: 1e9, suffix: 'G', name };
        if (m >= 1e6) return { div: 1e6, suffix: 'M', name };
        if (m >= 1e4) return { div: 1e3, suffix: 'k', name };
        return { div: 1, suffix: '', name };
    }

    function trimNumber(x, digits) {
        if (!isFinite(x)) return '–';
        const abs = Math.abs(x);
        const decimals = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
        return x.toFixed(digits === undefined ? decimals : digits);
    }

    function formatValue(value, unit, scale) {
        if (value === null || value === undefined || !isFinite(value)) return 'n/a';
        scale = scale || unitScale(unit, value);
        const number = trimNumber(value / scale.div);
        if (unit === 'seconds' || unit === 'bytes') return number + ' ' + scale.suffix;
        return number + scale.suffix;
    }

    const MINUS = '−';

    function formatPercent(p, digits) {
        if (p === null || !isFinite(p)) return 'n/a';
        const abs = Math.abs(p);
        const text = abs >= 100 ? abs.toFixed(0) : abs.toFixed(digits === undefined ? 1 : digits);
        if (text === '0.0' || text === '0') return '0%';
        return (p > 0 ? '+' : MINUS) + text + '%';
    }

    function percentChange(before, after) {
        if (!before || before === null || after === null) return null;
        return 100 * (after / before - 1);
    }

    function lowerIsBetter(unit) {
        return unit === 'seconds' || unit === 'bytes';
    }

    /* A signed % change, colored by direction when lower is better */
    function deltaNode(p, unit, significant) {
        if (p === null || !isFinite(p)) return el('span', { class: 'delta neutral', text: 'n/a' });
        let tone = 'neutral';
        if (significant !== false && lowerIsBetter(unit) && Math.abs(p) >= 0.05) {
            tone = p < 0 ? 'better' : 'worse';
        }
        const arrow = Math.abs(p) < 0.05 ? '' : p > 0 ? '▲' : '▼';
        const node = el('span', { class: 'delta ' + (significant === false ? 'noise' : tone) },
                        el('span', { class: 'arrow', 'aria-hidden': 'true', text: arrow }),
                        formatPercent(p));
        if (significant === false) node.title = 'Within the noise: the confidence intervals overlap';
        return node;
    }

    function shortHash(rev) {
        const hash = index.revision_to_hash[rev];
        return hash ? hash.slice(0, index.hash_length || 8) : String(rev);
    }

    function commitSubject(rev) {
        return (index.revision_to_subject || {})[rev] || '';
    }

    function commitDate(rev) {
        const t = index.revision_to_date[rev];
        return t ? new Date(t) : null;
    }

    function formatDate(date, withTime) {
        if (!date) return '';
        const opts = { year: 'numeric', month: 'short', day: 'numeric' };
        if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
        return date.toLocaleString(undefined, opts);
    }

    function formatShortDate(date) {
        if (!date) return '';
        const now = new Date();
        const opts = { month: 'short', day: 'numeric' };
        if (date.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
        return date.toLocaleDateString(undefined, opts);
    }

    function commitLink(rev, text) {
        const hash = index.revision_to_hash[rev];
        if (!hash || !index.show_commit_url) return el('span', { class: 'mono', text: text || shortHash(rev) });
        return el('a', { class: 'mono', href: index.show_commit_url + hash, target: '_blank', rel: 'noopener',
                         text: text || shortHash(rev) });
    }

    /* Python repr of a parameter value -> display text */
    function paramText(repr) {
        if (repr === null || repr === undefined) return '[none]';
        let m = /^u?'(.*)'$/.exec(repr) || /^"(.*)"$/.exec(repr) || /^<class '(.+)'>$/.exec(repr);
        return m ? m[1] : repr;
    }

    function splitName(name) {
        const bm = index.benchmarks[name];
        const parts = name.split('.');
        const leaf = (bm && bm.pretty_name) || parts[parts.length - 1];
        const group = bm && bm.pretty_name ? '' : parts.slice(0, -1).join('.');
        return { group, leaf };
    }

    function displayName(name) {
        const { group, leaf } = splitName(name);
        return group ? group.split('.').pop() + '.' + leaf : leaf;
    }

    // ------------------------------------------------------------------
    // URL state
    //
    // #b=<benchmark>&o=<overlay>...&scale=linear|log|indexed
    //  &view=timeline|scatter&sx=<line>&x=commits|dates&range=<n>
    //  &thr=<percent>&commit=<hash>&e-<env param>=<value>...&p-<param>=<repr>...

    const DEFAULTS = { scale: 'linear', view: 'timeline', x: 'commits', range: 'all', thr: '1', sx: '0',
                       sort: 'recent', show: 'changed', window: '25' };
    const NONE = '[none]';

    function parseHash() {
        const text = decodeURIComponentSafe(window.location.hash.replace(/^#\/?/, ''));
        const params = new URLSearchParams(text.includes('=') ? text : '');
        const state = { b: params.get('b'), o: params.getAll('o'), env: {}, p: {} };
        for (const key of Object.keys(DEFAULTS)) state[key] = params.get(key) || DEFAULTS[key];
        state.commit = params.get('commit');
        for (const [key, value] of params.entries()) {
            const v = value === NONE ? null : value;
            if (key.startsWith('e-')) (state.env[key.slice(2)] = state.env[key.slice(2)] || []).push(v);
            if (key.startsWith('p-')) (state.p[key.slice(2)] = state.p[key.slice(2)] || []).push(v);
        }
        return state;
    }

    function decodeURIComponentSafe(text) {
        // URLSearchParams decodes itself; only undo a fully encoded hash
        return text.startsWith('b%3D') ? decodeURIComponent(text) : text;
    }

    function formatHash(state) {
        const params = new URLSearchParams();
        if (state.b) params.append('b', state.b);
        for (const o of state.o || []) params.append('o', o);
        for (const key of Object.keys(DEFAULTS)) {
            if (state[key] && state[key] !== DEFAULTS[key]) params.append(key, state[key]);
        }
        if (state.commit) params.append('commit', state.commit);
        for (const [key, values] of Object.entries(state.env || {})) {
            for (const v of values) params.append('e-' + key, v === null ? NONE : v);
        }
        for (const [key, values] of Object.entries(state.p || {})) {
            for (const v of values) params.append('p-' + key, v === null ? NONE : v);
        }
        const text = params.toString();
        return '#' + text;
    }

    function hrefFor(changes) {
        const state = Object.assign(parseHash(), changes);
        return formatHash(state);
    }

    function navigate(changes) {
        window.location.hash = hrefFor(changes);
    }

    /* Change the URL without re-rendering (e.g. a pinned commit) */
    function replaceState(changes) {
        const hash = hrefFor(changes);
        history.replaceState(null, '', hash);
    }

    // ------------------------------------------------------------------
    // Selections: machines/environments and benchmark parameters

    let index = null;
    let changesIndex = null;

    /* Values of each environment parameter selected in `state`: all by
       default, except only the first branch. */
    function envSelection(state) {
        const selection = {};
        for (const [param, values] of Object.entries(index.params)) {
            if (state.env[param] && state.env[param].length) {
                selection[param] = state.env[param].filter(v => values.includes(v));
                if (!selection[param].length) selection[param] = values.slice();
            } else if (param === 'branch') {
                selection[param] = values.slice(0, 1);
            } else {
                selection[param] = values.slice();
            }
        }
        return selection;
    }

    function matchingGraphParams(selection) {
        return index.graph_param_list.filter(params =>
            Object.entries(selection).every(([key, values]) => values.includes(params[key])));
    }

    /* For each parameter of a benchmark, the indices of the selected
       values: those named in p-<name>, else up to 8 lines in total. */
    function paramSelection(bm, state) {
        const selection = [];
        let count = 1;
        bm.params.forEach((values, k) => {
            const chosen = state.p[bm.param_names[k]];
            let items = [];
            if (chosen && chosen.length) {
                items = values.map((v, j) => j).filter(j => chosen.includes(values[j]));
            }
            if (!items.length) {
                for (let j = 0; j < values.length && (j + 1) * count <= 8; ++j) items.push(j);
                if (!items.length) items.push(0);
            }
            count *= items.length;
            selection.push(items);
        });
        return selection;
    }

    function product(lists) {
        return lists.reduce((acc, list) => acc.flatMap(prefix => list.map(item => prefix.concat([item]))), [[]]);
    }

    // ------------------------------------------------------------------
    // Lines: one benchmark x one machine/environment x one parameter set

    const MAX_LINES = 8;
    const colorSlots = new Map();   // line key -> slot, so a line keeps its color

    function buildLines(state) {
        const benches = [state.b].concat(state.o.filter(n => n !== state.b && index.benchmarks[n]));
        const selection = envSelection(state);
        const perms = matchingGraphParams(selection);
        const lines = [];

        // Environment parameters that differ between the selected graphs
        const differing = Object.keys(index.params).filter(key =>
            new Set(perms.map(p => JSON.stringify(p[key]))).size > 1);

        for (const bench of benches) {
            const bm = index.benchmarks[bench];
            const sel = paramSelection(bm, state);
            const varying = bm.param_names.filter((name, k) => sel[k].length > 1 || bm.params[k].length > 1);
            for (const perm of perms) {
                for (const combo of product(sel)) {
                    let flat = 0;
                    combo.forEach((j, k) => { flat = flat * bm.params[k].length + j; });
                    const parts = [];
                    if (benches.length > 1) parts.push(displayName(bench));
                    for (const key of differing) parts.push(`${key} ${perm[key] === null ? NONE : perm[key]}`);
                    combo.forEach((j, k) => {
                        if (varying.includes(bm.param_names[k])) {
                            parts.push(`${bm.param_names[k]}=${paramText(bm.params[k][j])}`);
                        }
                    });
                    lines.push({
                        key: bench + '|' + JSON.stringify(perm) + '|' + combo.join(','),
                        bench,
                        unit: bm.unit,
                        perm,
                        flat: bm.params.length ? flat : null,
                        label: parts.join(' · ') || displayName(bench),
                        path: graphPath(bench, perm),
                        detailPath: graphPath(bench, perm, 'details'),
                    });
                }
            }
        }
        const total = lines.length;
        const shown = lines.slice(0, MAX_LINES);

        // Keep colors of lines still shown; give new lines the free slots
        const used = new Set();
        for (const line of shown) {
            if (colorSlots.has(line.key)) used.add(colorSlots.get(line.key));
        }
        for (const line of shown) {
            let slot = colorSlots.get(line.key);
            if (slot === undefined || [...shown].filter(l => colorSlots.get(l.key) === slot).length > 1) {
                slot = 0;
                while (used.has(slot)) slot++;
                colorSlots.set(line.key, slot);
                used.add(slot);
            }
            line.slot = slot % 8;
        }
        return { lines: shown, total };
    }

    function lineColor(line) {
        return cssVar('--series-' + (line.slot + 1));
    }

    /* Load the values and confidence intervals of each line:
       line.points = [{rev, y, lo, hi}], sorted by revision. */
    async function loadLines(lines) {
        await Promise.all(lines.map(async line => {
            const [data, detail] = await Promise.all([loadJSON(line.path, true), loadJSON(line.detailPath, true)]);
            const intervals = new Map();
            for (const row of (detail && detail.interval) || []) {
                if (line.flat === null) intervals.set(row[0], [row[1], row[2]]);
                else if (Array.isArray(row[1])) intervals.set(row[0], [row[1][line.flat], row[2][line.flat]]);
            }
            line.missing = !data;
            line.points = [];
            for (const [rev, value] of data || []) {
                const y = line.flat === null ? value : (value ? value[line.flat] : null);
                if (y === null || y === undefined || !isFinite(y)) continue;
                const ci = intervals.get(rev);
                const ok = ci && ci[0] !== null && ci[1] !== null;
                line.points.push({ rev, y, lo: ok ? ci[0] : null, hi: ok ? ci[1] : null });
            }
            line.exact = line.points.every(p => p.lo === null);
        }));
    }

    /* Commit-to-commit changes of a line.  Same rule as
       asv.graph.Graph.get_changes: confidence intervals must not
       overlap; a line without intervals is exact. */
    function lineChanges(line, points) {
        const changes = [];
        points = points || line.points;
        for (let i = 1; i < points.length; ++i) {
            const a = points[i - 1];
            const b = points[i];
            let significant;
            if (line.exact) significant = a.y !== b.y;
            else if (a.lo !== null && b.lo !== null) significant = b.lo > a.hi || b.hi < a.lo;
            else significant = false;
            changes.push({ line, prev: a, cur: b, pct: percentChange(a.y, b.y), significant });
        }
        return changes;
    }

    // ------------------------------------------------------------------
    // Sidebar tree

    let treeBuilt = false;

    function buildTree() {
        const root = { children: new Map(), leaves: [] };
        for (const name of Object.keys(index.benchmarks).sort()) {
            const parts = name.split('.');
            let node = root;
            for (const part of parts.slice(0, -1)) {
                if (!node.children.has(part)) node.children.set(part, { children: new Map(), leaves: [] });
                node = node.children.get(part);
            }
            node.leaves.push(name);
        }

        function renderNode(node, depth) {
            const out = [];
            for (const [part, child] of node.children) {
                const details = el('details', { open: depth < 1 ? true : null, 'data-group': part },
                                   el('summary', { text: part }),
                                   el('div', { class: 'children' }, renderNode(child, depth + 1)));
                out.push(details);
            }
            for (const name of node.leaves) {
                const { leaf } = splitName(name);
                const link = el('a', { href: '#', 'data-bench': name, text: leaf, title: name });
                link.addEventListener('click', event => {
                    event.preventDefault();
                    const state = parseHash();
                    navigate({ b: name, o: state.o.filter(o => o !== name), commit: null });
                    closeSidebar();
                });
                const toggle = el('button', {
                    type: 'button', class: 'overlay-toggle', text: '+',
                    'aria-label': 'Add ' + name + ' to the graph',
                    title: 'Add to the graph',
                });
                toggle.addEventListener('click', () => {
                    const state = parseHash();
                    if (!state.b) { navigate({ b: name }); return; }
                    if (name === state.b) return;
                    const o = state.o.includes(name) ? state.o.filter(x => x !== name) : state.o.concat([name]);
                    navigate({ o });
                });
                out.push(el('div', { class: 'leaf', 'data-name': name.toLowerCase(), role: 'treeitem' },
                            el('span', { class: 'swatch' }), link, toggle));
            }
            return out;
        }

        const tree = document.getElementById('tree');
        tree.replaceChildren(...renderNode(root, 0));
        treeBuilt = true;
    }

    function updateTree(state, lines) {
        const colors = new Map();
        for (const line of lines || []) {
            if (!colors.has(line.bench)) colors.set(line.bench, lineColor(line));
        }
        for (const leaf of document.querySelectorAll('#tree .leaf')) {
            const name = leaf.querySelector('a').dataset.bench;
            const current = name === state.b;
            const overlaid = state.o.includes(name);
            leaf.classList.toggle('current', current);
            leaf.classList.toggle('overlaid', overlaid);
            const toggle = leaf.querySelector('.overlay-toggle');
            toggle.textContent = overlaid ? '−' : '+';
            toggle.hidden = current;
            toggle.setAttribute('aria-label', (overlaid ? 'Remove ' : 'Add ') + name + (overlaid ? ' from' : ' to') + ' the graph');
            toggle.title = overlaid ? 'Remove from the graph' : 'Add to the graph';
            const swatch = leaf.querySelector('.swatch');
            swatch.style.background = (current || overlaid) && colors.get(name) ? colors.get(name) : 'transparent';
            if (current) {
                for (let p = leaf.parentElement; p && p.id !== 'tree'; p = p.parentElement) {
                    if (p.tagName === 'DETAILS') p.open = true;
                }
            }
        }
    }

    function applySearch() {
        const query = document.getElementById('search').value.trim().toLowerCase();
        const words = query.split(/\s+/).filter(Boolean);
        const matches = name => words.every(w => name.includes(w));
        let any = false;
        for (const leaf of document.querySelectorAll('#tree .leaf')) {
            const ok = matches(leaf.dataset.name);
            leaf.hidden = !ok;
            any = any || ok;
        }
        for (const details of [...document.querySelectorAll('#tree details')].reverse()) {
            const visible = details.querySelector('.leaf:not([hidden])');
            details.hidden = !visible;
            if (words.length && visible) details.open = true;
        }
        let empty = document.querySelector('#tree .tree-empty');
        if (!any) {
            if (!empty) document.getElementById('tree').append(el('p', { class: 'tree-empty', text: 'No benchmark matches.' }));
        } else if (empty) {
            empty.remove();
        }
        if (currentView === 'overview') renderOverviewRows();
    }

    function closeSidebar() {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('sidebar-toggle').setAttribute('aria-expanded', 'false');
    }

    // ------------------------------------------------------------------
    // Controls

    function segmented(label, current, options, onChange) {
        const group = el('div', { class: 'segmented', role: 'group', 'aria-label': label });
        for (const opt of options) {
            const button = el('button', {
                type: 'button', text: opt.label, 'aria-pressed': String(opt.value === current),
                disabled: opt.disabled || null, title: opt.title || null,
            });
            button.addEventListener('click', () => { if (opt.value !== current) onChange(opt.value); });
            group.append(button);
        }
        return el('div', { class: 'control' }, el('span', { class: 'control-label', text: label }), group);
    }

    function selectControl(label, id, current, options, onChange) {
        const select = el('select', { class: 'select', id });
        for (const opt of options) {
            select.append(el('option', { value: opt.value, text: opt.label, selected: opt.value === current || null }));
        }
        select.addEventListener('change', () => onChange(select.value));
        return el('div', { class: 'control' }, el('label', { class: 'control-label', for: id, text: label }), select);
    }

    /* Toggle buttons for the values of one parameter */
    function valueToggles(label, values, selected, textOf, onChange) {
        const group = el('div', { class: 'segmented', role: 'group', 'aria-label': label });
        values.forEach(value => {
            const on = selected.includes(value);
            const button = el('button', { type: 'button', 'aria-pressed': String(on), text: textOf(value) });
            button.addEventListener('click', () => {
                let next = on ? selected.filter(v => v !== value) : selected.concat([value]);
                if (!next.length) next = [value];
                onChange(values.filter(v => next.includes(v)));
            });
            group.append(button);
        });
        return el('div', { class: 'control' }, el('span', { class: 'control-label', text: label }), group);
    }

    // ------------------------------------------------------------------
    // Graph page

    let currentView = null;
    let charts = [];            // uPlot instances of the timeline panels
    let scatter = null;         // scatter renderer
    let pinned = null;          // pinned revision
    let hovered = null;
    let graphContext = null;    // everything the hover/pin handlers need
    let resizeObserver = null;

    function destroyCharts() {
        for (const chart of charts) chart.destroy();
        charts = [];
        scatter = null;
        if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    }

    async function renderGraph(state) {
        currentView = 'graph';
        const main = document.getElementById('main');
        const bm = index.benchmarks[state.b];
        const { lines, total } = buildLines(state);
        await loadLines(lines);
        if (parseHash().b !== state.b) return; // navigated away while loading

        destroyCharts();
        pinned = state.commit ? revisionOf(state.commit) : null;
        hovered = null;

        // Revisions on the x-axis, restricted to the range
        let revs = [...new Set(lines.flatMap(l => l.points.map(p => p.rev)))].sort((a, b) => a - b);
        if (state.range !== 'all') revs = revs.slice(-parseInt(state.range, 10));
        const revSet = new Set(revs);
        for (const line of lines) {
            line.shown = line.points.filter(p => revSet.has(p.rev));
            line.changes = lineChanges(line, line.shown);
        }

        const threshold = parseFloat(state.thr) || 0;
        graphContext = { state, lines, revs, threshold };

        const { group, leaf } = splitName(state.b);
        const header = el('div', { class: 'title-row' },
            el('h1', {}, group ? el('span', { class: 'group', text: group + '.' }) : null, leaf),
            el('span', { class: 'chip', text: bm.unit === 'unit' ? 'no unit' : bm.unit.replace(/_/g, ' ') }),
            ...state.o.filter(o => index.benchmarks[o] && o !== state.b).map(o => el('span', { class: 'chip' },
                '+ ' + displayName(o),
                el('button', { type: 'button', 'aria-label': 'Remove ' + o + ' from the graph', text: '×',
                               onclick: () => navigate({ o: state.o.filter(x => x !== o) }) }))));

        const nodes = [header, renderSelectors(state), renderViewControls(state, lines)];
        if (total > lines.length) {
            nodes.push(el('p', { class: 'notice', text: `Showing ${lines.length} of ${total} lines. Select fewer machines or parameter values to see the others.` }));
        }
        const missing = lines.filter(l => l.missing);
        if (missing.length === lines.length) {
            nodes.push(el('p', { class: 'notice', text: 'No results for this selection of machines and parameters.' }));
            main.replaceChildren(...nodes);
            updateTree(state, lines);
            return;
        }

        const chartCard = el('section', { class: 'card', 'aria-label': 'Graph' });
        nodes.push(chartCard);
        const commitCard = el('section', { class: 'card', id: 'commit-card', 'aria-label': 'Commit' });
        const changesCard = el('section', { class: 'card', 'aria-label': 'Changes' });
        nodes.push(commitCard, changesCard);
        main.replaceChildren(...nodes);
        updateTree(state, lines);

        if (state.view === 'scatter' && lines.length >= 2) {
            renderScatter(chartCard, state, lines);
        } else {
            renderTimeline(chartCard, state, lines, revs);
        }
        renderCommitCard();
        renderChangesCard(changesCard, state, lines, threshold);
    }

    function revisionOf(hash) {
        for (const [rev, full] of Object.entries(index.revision_to_hash)) {
            if (full.startsWith(hash)) return parseInt(rev, 10);
        }
        return null;
    }

    function renderSelectors(state) {
        const row = el('div', { class: 'controls' });
        const selection = envSelection(state);
        for (const [param, values] of Object.entries(index.params)) {
            if (values.length < 2) continue;
            row.append(valueToggles(param, values, selection[param], v => v === null ? NONE : (v || '[default]'), next => {
                const env = Object.assign({}, state.env);
                env[param] = next;
                navigate({ env });
            }));
        }
        const benches = [state.b].concat(state.o.filter(o => index.benchmarks[o]));
        const seen = new Set();
        for (const bench of benches) {
            const bm = index.benchmarks[bench];
            const sel = paramSelection(bm, state);
            bm.param_names.forEach((name, k) => {
                if (seen.has(name) || bm.params[k].length < 2) return;
                seen.add(name);
                const selected = sel[k].map(j => bm.params[k][j]);
                row.append(valueToggles(name, bm.params[k], selected, paramText, next => {
                    const p = Object.assign({}, state.p);
                    p[name] = next;
                    navigate({ p });
                }));
            });
        }
        return row;
    }

    function renderViewControls(state, lines) {
        const row = el('div', { class: 'controls' });
        row.append(segmented('View', state.view, [
            { value: 'timeline', label: 'Timeline' },
            { value: 'scatter', label: 'Change vs change', disabled: lines.length < 2,
              title: lines.length < 2 ? 'Needs two or more lines: add a benchmark with + in the list' : null },
        ], view => navigate({ view })));
        if (state.view !== 'scatter' || lines.length < 2) {
            row.append(segmented('Scale', state.scale, [
                { value: 'linear', label: 'Linear' },
                { value: 'log', label: 'Log' },
                { value: 'indexed', label: 'Indexed', title: 'Each line as % of its first value in the range' },
            ], scale => navigate({ scale })));
            row.append(segmented('X-axis', state.x, [
                { value: 'commits', label: 'Commits' },
                { value: 'dates', label: 'Dates' },
            ], x => navigate({ x })));
        } else {
            row.append(selectControl('X-axis line', 'scatter-x', state.sx,
                lines.map((l, i) => ({ value: String(i), label: l.label })), sx => navigate({ sx })));
        }
        row.append(selectControl('Range', 'range', state.range, [
            { value: 'all', label: 'All commits' },
            { value: '200', label: 'Last 200 commits' },
            { value: '100', label: 'Last 100 commits' },
            { value: '50', label: 'Last 50 commits' },
            { value: '20', label: 'Last 20 commits' },
        ], range => navigate({ range })));
        return row;
    }

    // ----- Timeline

    function renderTimeline(card, state, lines, revs) {
        const indexed = state.scale === 'indexed';
        const log = state.scale === 'log';
        const dates = state.x === 'dates';

        // x values: position in the commit list, or the commit date
        let xs;
        if (dates) {
            let prev = -Infinity;
            xs = revs.map(rev => {
                let t = (index.revision_to_date[rev] || 0) / 1000;
                if (t <= prev) t = prev + 1;  // uPlot needs increasing x
                prev = t;
                return t;
            });
        } else {
            xs = revs.map((rev, i) => i);
        }
        const position = new Map(revs.map((rev, i) => [rev, i]));

        // Panels: one per unit, or one for indexed values
        const groups = new Map();
        for (const line of lines) {
            if (line.missing) continue;
            const key = indexed ? '%' : line.unit;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(line);
        }

        const panelsNode = el('div', { class: 'panels' });
        const legend = el('div', { class: 'legend', role: 'group', 'aria-label': 'Lines' });
        card.append(panelsNode, legend,
                    el('p', { class: 'chart-hint', text: 'Hover for values; click to pin a commit; drag to zoom, double-click to reset. Triangles mark changes beyond the noise of at least ' + formatPercent(graphContext.threshold, 1).replace('+', '') + '.' }));

        const panelHeight = Math.max(170, Math.min(360, Math.round(520 / groups.size)));
        const syncKey = 'asv-' + Math.random().toString(36).slice(2);
        const surface = cssVar('--surface');
        const alpha = parseFloat(cssVar('--band-alpha')) || 0.13;
        const panelList = [...groups.entries()];

        panelList.forEach(([unit, panelLines], panelIndex) => {
            // Values
            const series = [{}];
            const data = [xs];
            const bands = [];
            let maxAbs = 0;
            let valueMin = Infinity;
            let valueMax = -Infinity;
            for (const line of panelLines) {
                const y = new Array(xs.length).fill(null);
                const lo = new Array(xs.length).fill(null);
                const hi = new Array(xs.length).fill(null);
                const base = indexed ? (line.shown.find(p => p.y) || {}).y : null;
                for (const p of line.shown) {
                    const i = position.get(p.rev);
                    const f = indexed ? (base ? 100 / base : null) : 1;
                    if (f === null) continue;
                    y[i] = p.y * f;
                    if (p.lo !== null) { lo[i] = p.lo * f; hi[i] = p.hi * f; }
                    if (log) {
                        if (!(y[i] > 0)) y[i] = null;
                        if (!(lo[i] > 0)) { lo[i] = null; hi[i] = null; }
                    }
                    if (y[i] !== null) {
                        maxAbs = Math.max(maxAbs, Math.abs(y[i]));
                        valueMin = Math.min(valueMin, y[i]);
                        valueMax = Math.max(valueMax, y[i]);
                    }
                }
                line.panel = panelIndex;
                line.seriesIndex = data.length;
                line.indexBase = base;
                const color = lineColor(line);
                data.push(y, lo, hi);
                series.push({
                    label: line.label,
                    stroke: color,
                    width: 2,
                    spanGaps: true,
                    points: { show: xs.length <= 80, size: 6, stroke: color, fill: surface, width: 2 },
                });
                series.push({ label: line.label + ' low', stroke: 'transparent', width: 0, points: { show: false }, spanGaps: true });
                series.push({ label: line.label + ' high', stroke: 'transparent', width: 0, points: { show: false }, spanGaps: true });
                if (!line.exact) {
                    bands.push({ series: [line.seriesIndex + 2, line.seriesIndex + 1], fill: withAlpha(color, alpha) });
                }
            }

            const scaleUnit = indexed ? '%' : unit;
            const scale = indexed ? { div: 1, suffix: '%', name: '% of first value' } : unitScale(scaleUnit, maxAbs);
            const panelLabel = indexed ? '% of first value in the range'
                : (unit === 'seconds' ? 'time' : unit === 'bytes' ? 'memory' : (unit === 'unit' ? 'value' : unit.replace(/_/g, ' ')))
                  + (scale.suffix && (unit === 'seconds' || unit === 'bytes') ? ` (${scale.suffix})` : '')
                  + (!(unit === 'seconds' || unit === 'bytes') && scale.suffix ? ` (${scale.suffix === 'k' ? 'thousands' : scale.suffix === 'M' ? 'millions' : 'billions'})` : '');

            const zeroBased = !log && !indexed && lowerIsBetter(unit);
            const opts = {
                width: Math.max(280, card.clientWidth - 32),
                height: panelHeight,
                legend: { show: false },
                padding: [10, 12, 0, 4],
                series,
                bands,
                cursor: {
                    sync: { key: syncKey, setSeries: false },
                    drag: { x: true, y: false, setScale: true },
                    points: { size: 8, width: 2, fill: surface },
                    focus: { prox: 30 },
                },
                focus: { alpha: 0.35 },
                scales: {
                    x: { time: dates },
                    y: {
                        distr: log ? 3 : 1,
                        // Fit the values; a wide confidence band is clipped
                        range: () => {
                            let min = valueMin, max = valueMax;
                            if (!isFinite(min)) return [0, 1];
                            if (log) return uPlot.rangeLog(min, max, 10, true);
                            if (zeroBased) return [0, max * 1.08 || 1];
                            const pad = (max - min) * 0.08 || Math.abs(max) * 0.05 || 1;
                            return [min - pad, max + pad];
                        },
                    },
                },
                axes: [
                    {
                        show: panelIndex === panelList.length - 1,
                        stroke: cssVar('--muted'),
                        grid: { stroke: cssVar('--grid'), width: 1 },
                        ticks: { stroke: cssVar('--grid'), width: 1, size: 4 },
                        space: 70,
                        values: dates ? undefined : (u, splits) => {
                            // A date only where it differs from the tick before
                            let previous = null;
                            return splits.map(i => {
                                if (!Number.isInteger(i) || i < 0 || i >= revs.length) return '';
                                const text = formatShortDate(commitDate(revs[i]));
                                if (text === previous) return '';
                                previous = text;
                                return text;
                            });
                        },
                        incrs: dates ? undefined : [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000],
                    },
                    {
                        stroke: cssVar('--muted'),
                        grid: { stroke: cssVar('--grid'), width: 1 },
                        ticks: { show: false },
                        size: 56,
                        values: (u, splits) => {
                            // Same number of decimals on every tick of an axis
                            const step = splits.length > 1 ? Math.abs(splits[1] - splits[0]) / scale.div : 1;
                            let decimals = null;
                            if (!log) {
                                decimals = 0;
                                while (decimals < 6 && Math.abs(step * 10 ** decimals - Math.round(step * 10 ** decimals)) > 1e-6) decimals++;
                            }
                            return splits.map(v => {
                                const n = v / scale.div;
                                const text = decimals === null ? trimNumber(n) : n.toFixed(decimals);
                                return indexed ? text + '%' : text;
                            });
                        },
                    },
                ],
                hooks: {
                    draw: [u => drawMarkers(u, panelLines, revs, position, xs)],
                    setCursor: [u => onCursor(u)],
                    setSelect: [u => syncZoom(u)],
                },
            };

            const wrapper = el('div', { class: 'panel' }, el('div', { class: 'panel-label', text: panelLabel }));
            panelsNode.append(wrapper);
            const chart = new uPlot(opts, data, wrapper);
            chart.asv = { lines: panelLines, revs, xs, unit, indexed, scale };
            chart.over.addEventListener('mousedown', e => { chart.asvDown = e.clientX; });
            chart.over.addEventListener('click', e => {
                if (chart.asvDown !== undefined && Math.abs(e.clientX - chart.asvDown) > 3) return;
                const idx = chart.cursor.idx;
                if (idx === null || idx === undefined) return;
                pinCommit(pinned === revs[idx] ? null : revs[idx]);
            });
            chart.over.addEventListener('dblclick', () => resetZoom());
            chart.over.addEventListener('mouseleave', () => { hideTooltip(); hovered = null; renderCommitCard(); });
            charts.push(chart);
        });

        // Legend: click a line to hide or show it
        for (const line of lines) {
            if (line.missing) continue;
            const button = el('button', { type: 'button', 'aria-pressed': 'true' },
                              el('span', { class: 'key', style: { background: lineColor(line) } }),
                              line.label);
            button.addEventListener('click', () => {
                const show = button.getAttribute('aria-pressed') !== 'true';
                button.setAttribute('aria-pressed', String(show));
                const chart = charts[line.panel];
                for (let k = 0; k < 3; ++k) chart.setSeries(line.seriesIndex + k, { show });
            });
            legend.append(button);
        }
        for (const line of lines.filter(l => l.missing)) {
            legend.append(el('span', { class: 'noise', text: line.label + ': no results' }));
        }

        resizeObserver = new ResizeObserver(() => {
            const width = Math.max(280, card.clientWidth - 32);
            for (const chart of charts) {
                if (Math.abs(chart.width - width) > 1) chart.setSize({ width, height: chart.height });
            }
        });
        resizeObserver.observe(card);
    }

    let syncing = false;
    function syncZoom(u) {
        if (syncing || !u.select.width) return;
        const min = u.posToVal(u.select.left, 'x');
        const max = u.posToVal(u.select.left + u.select.width, 'x');
        syncing = true;
        for (const chart of charts) {
            if (chart !== u) chart.setScale('x', { min, max });
        }
        syncing = false;
    }

    function resetZoom() {
        for (const chart of charts) {
            const xs = chart.data[0];
            chart.setScale('x', { min: xs[0], max: xs[xs.length - 1] });
        }
    }

    /* Tags and the significant changes of each line */
    function drawMarkers(u, lines, revs, position, xs) {
        const ctx = u.ctx;
        const dpr = uPlot.pxRatio;
        const top = u.bbox.top;
        const height = u.bbox.height;
        ctx.save();

        // Tags: a hairline and the name
        ctx.font = `${11 * dpr}px ${cssVar('--font-ui') || 'sans-serif'}`;
        ctx.fillStyle = cssVar('--muted');
        ctx.strokeStyle = cssVar('--axis');
        ctx.lineWidth = dpr;
        for (const [tag, rev] of Object.entries(index.tags || {})) {
            let i = revs.findIndex(r => r >= rev);
            if (i < 0) continue;
            const x = Math.round(u.valToPos(xs[i], 'x', true));
            if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue;
            ctx.beginPath();
            ctx.moveTo(x, top);
            ctx.lineTo(x, top + height);
            ctx.stroke();
            ctx.fillText(tag, x + 3 * dpr, top + 26 * dpr);
        }

        // Changes beyond the noise and the threshold: a small triangle
        // at the top of the plot, pointing in the direction of change
        const threshold = graphContext.threshold;
        for (const line of lines) {
            if (!u.series[line.seriesIndex].show) continue;
            ctx.fillStyle = lineColor(line);
            for (const change of line.changes) {
                if (!change.significant || Math.abs(change.pct) < threshold) continue;
                const i = position.get(change.cur.rev);
                const x = u.valToPos(xs[i], 'x', true);
                if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue;
                const s = 4 * dpr;
                const y = top + 3 * dpr + (change.pct > 0 ? 0 : s);
                ctx.beginPath();
                if (change.pct > 0) {
                    ctx.moveTo(x - s, y + s); ctx.lineTo(x + s, y + s); ctx.lineTo(x, y);
                } else {
                    ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y - s); ctx.lineTo(x, y);
                }
                ctx.closePath();
                ctx.fill();
            }
        }

        // Pinned commit
        if (pinned !== null && position.has(pinned)) {
            const x = Math.round(u.valToPos(xs[position.get(pinned)], 'x', true));
            ctx.strokeStyle = cssVar('--accent');
            ctx.lineWidth = 2 * dpr;
            ctx.beginPath();
            ctx.moveTo(x, top);
            ctx.lineTo(x, top + height);
            ctx.stroke();
        }
        ctx.restore();
    }

    function onCursor(u) {
        const idx = u.cursor.idx;
        if (idx === null || idx === undefined || u.cursor.left < 0) {
            return;
        }
        const rev = u.asv.revs[idx];
        if (hovered === rev && !tooltipHidden()) {
            positionTooltip(u);
            return;
        }
        hovered = rev;
        // Only the chart under the pointer shows the tooltip
        if (u.over.matches(':hover')) {
            showTimelineTooltip(u, rev);
            renderCommitCard();
        }
    }

    // ----- Tooltip

    function tooltipHidden() {
        return document.getElementById('tooltip').hidden;
    }

    function hideTooltip() {
        document.getElementById('tooltip').hidden = true;
    }

    function showTimelineTooltip(u, rev) {
        const tooltip = document.getElementById('tooltip');
        const rows = [];
        for (const chart of charts) {
            for (const line of chart.asv.lines) {
                if (!chart.series[line.seriesIndex].show) continue;
                const point = line.points.find(p => p.rev === rev);
                if (!point) continue;
                const value = chart.asv.indexed && line.indexBase
                    ? trimNumber(100 * point.y / line.indexBase) + '%'
                    : formatValue(point.y, line.unit);
                rows.push(el('div', { class: 'tt-row' },
                             el('span', { class: 'key', style: { background: lineColor(line) } }),
                             el('strong', { text: value }),
                             el('span', { class: 'tt-name', text: line.label })));
            }
        }
        tooltip.replaceChildren(
            el('div', { class: 'tt-head' }, shortHash(rev), ' · ', formatDate(commitDate(rev), true)),
            commitSubject(rev) ? el('div', { class: 'tt-subject', text: commitSubject(rev) }) : null,
            ...rows);
        tooltip.hidden = false;
        positionTooltip(u);
    }

    function positionTooltip(u) {
        const tooltip = document.getElementById('tooltip');
        const rect = u.over.getBoundingClientRect();
        const x = rect.left + u.cursor.left;
        const y = rect.top + (u.cursor.top || 0);
        placeTooltip(tooltip, x, y);
    }

    function placeTooltip(tooltip, x, y) {
        const w = tooltip.offsetWidth;
        const h = tooltip.offsetHeight;
        let left = x + 16;
        if (left + w > window.innerWidth - 8) left = x - w - 16;
        let top = y - h / 2;
        top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
        tooltip.style.left = Math.max(8, left) + 'px';
        tooltip.style.top = top + 'px';
    }

    // ----- Pinned / hovered commit

    function pinCommit(rev) {
        pinned = rev;
        replaceState({ commit: rev === null ? null : shortHash(rev) });
        for (const chart of charts) chart.redraw(false, false);
        if (scatter) scatter.draw();
        renderCommitCard();
        highlightChangeRows();
    }

    function renderCommitCard() {
        const card = document.getElementById('commit-card');
        if (!card || !graphContext) return;
        const { lines, revs } = graphContext;
        const rev = pinned !== null ? pinned : hovered !== null ? hovered : revs[revs.length - 1];
        if (rev === undefined || rev === null) {
            card.replaceChildren(el('h2', { text: 'Commit' }), el('p', { class: 'empty-state', text: 'No commits in this range.' }));
            return;
        }
        const pos = revs.indexOf(rev);
        const prevRev = pos > 0 ? revs[pos - 1] : null;
        const nextRev = pos >= 0 && pos < revs.length - 1 ? revs[pos + 1] : null;
        const tags = Object.entries(index.tags || {}).filter(([t, r]) => r === rev).map(([t]) => t);

        const nav = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Step through commits' },
            el('button', { type: 'button', text: '‹ Earlier', disabled: prevRev === null || null,
                           onclick: () => pinCommit(prevRev) }),
            el('button', { type: 'button', text: pinned !== null ? 'Unpin' : 'Pin',
                           'aria-pressed': String(pinned !== null),
                           onclick: () => pinCommit(pinned !== null ? null : rev) }),
            el('button', { type: 'button', text: 'Later ›', disabled: nextRev === null || null,
                           onclick: () => pinCommit(nextRev) }));

        const rows = [];
        for (const line of lines) {
            if (line.missing) continue;
            const i = line.points.findIndex(p => p.rev === rev);
            if (i < 0) {
                rows.push(el('tr', {}, el('td', {}, lineCell(line)), el('td', { class: 'num noise', text: 'no result' }), el('td'), el('td')));
                continue;
            }
            const point = line.points[i];
            const prev = i > 0 ? line.points[i - 1] : null;
            const change = prev ? lineChanges(line, [prev, point])[0] : null;
            const ci = point.lo !== null
                ? el('div', { class: 'ci', text: '99% CI ' + formatValue(point.lo, line.unit) + ' – ' + formatValue(point.hi, line.unit) })
                : null;
            rows.push(el('tr', {},
                el('td', {}, lineCell(line)),
                el('td', { class: 'num' }, el('strong', { text: formatValue(point.y, line.unit) }), ci),
                el('td', { class: 'num' }, change ? deltaNode(change.pct, line.unit, change.significant) : el('span', { class: 'noise', text: 'first result' })),
                el('td', { class: 'num' }, prev ? commitLink(prev.rev) : null)));
        }

        card.replaceChildren(
            el('div', { class: 'card-head' },
               el('h2', { text: pinned !== null ? 'Pinned commit' : hovered !== null ? 'Commit under the pointer' : 'Latest commit' }),
               el('span', { class: 'spacer' }), nav),
            el('div', { class: 'commit-head' },
               commitLink(rev, index.revision_to_hash[rev] ? index.revision_to_hash[rev].slice(0, 12) : String(rev)),
               el('span', { class: 'commit-meta', text: formatDate(commitDate(rev), true) }),
               ...tags.map(t => el('span', { class: 'chip', text: t }))),
            el('p', { class: 'commit-subject', text: commitSubject(rev) || '(no commit message recorded)' }),
            el('div', { class: 'table-wrap' },
               el('table', { class: 'data' },
                  el('thead', {}, el('tr', {},
                     el('th', { text: 'Line' }), el('th', { class: 'num', text: 'Value' }),
                     el('th', { class: 'num', text: 'vs. previous' }), el('th', { class: 'num', text: 'Previous' }))),
                  el('tbody', {}, rows))));
    }

    function lineCell(line) {
        return el('div', { class: 'line-cell' },
                  el('span', { class: 'key', style: { background: lineColor(line) } }),
                  el('span', { class: 'line-name', text: line.label }));
    }

    // ----- Changes table

    let changesSort = 'recent';
    let changesShowAll = false;

    function renderChangesCard(card, state, lines, threshold) {
        const all = lines.flatMap(line => line.missing ? [] : line.changes)
            .filter(c => c.significant && c.pct !== null && Math.abs(c.pct) >= threshold);
        if (changesSort === 'size') all.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
        else all.sort((a, b) => b.cur.rev - a.cur.rev || Math.abs(b.pct) - Math.abs(a.pct));

        const limit = changesShowAll ? all.length : 12;
        const rows = all.slice(0, limit).map(change => {
            const row = el('tr', { class: 'clickable', tabindex: '0', 'data-rev': change.cur.rev },
                el('td', {},
                   el('div', {}, commitLink(change.cur.rev)),
                   el('div', { class: 'subject', text: commitSubject(change.cur.rev) })),
                el('td', {}, lineCell(change.line)),
                el('td', { class: 'num' },
                   formatValue(change.prev.y, change.line.unit), ' → ', formatValue(change.cur.y, change.line.unit)),
                el('td', { class: 'num' }, deltaNode(change.pct, change.line.unit, true)));
            const pin = () => pinCommit(change.cur.rev);
            row.addEventListener('click', event => { if (!event.target.closest('a')) pin(); });
            row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pin(); } });
            return row;
        });

        const thresholdSelect = selectControl('Smallest change', 'threshold', state.thr, [
            { value: '0', label: 'Any' }, { value: '0.5', label: '0.5%' }, { value: '1', label: '1%' },
            { value: '2', label: '2%' }, { value: '5', label: '5%' }, { value: '10', label: '10%' },
            { value: '25', label: '25%' },
        ], thr => navigate({ thr }));

        const sortControl = segmented('Order', changesSort, [
            { value: 'recent', label: 'Newest' }, { value: 'size', label: 'Largest' },
        ], value => { changesSort = value; renderChangesCard(card, state, lines, threshold); });

        const body = all.length
            ? el('div', { class: 'table-wrap' },
                 el('table', { class: 'data' },
                    el('thead', {}, el('tr', {},
                       el('th', { text: 'Commit' }), el('th', { text: 'Line' }),
                       el('th', { class: 'num', text: 'Before → after' }), el('th', { class: 'num', text: 'Change' }))),
                    el('tbody', {}, rows)))
            : el('p', { class: 'empty-state', text: 'No change beyond the noise of at least ' + formatPercent(threshold, 1).replace('+', '') + ' in this range.' });

        const more = all.length > limit
            ? el('button', { type: 'button', class: 'icon-button', text: `Show all ${all.length}`,
                             onclick: () => { changesShowAll = true; renderChangesCard(card, state, lines, threshold); } })
            : null;

        card.replaceChildren(
            el('div', { class: 'card-head' },
               el('h2', { text: 'Changes beyond the noise' }),
               el('span', { class: 'chip', text: String(all.length) }),
               el('span', { class: 'spacer' }), sortControl, thresholdSelect),
            el('p', { class: 'subtitle', text: 'Between consecutive commits with results. Timings count when their 99% confidence intervals do not overlap; counts without intervals count on any change.' }),
            body, more);
        highlightChangeRows();
    }

    function highlightChangeRows() {
        for (const row of document.querySelectorAll('tr[data-rev]')) {
            row.classList.toggle('selected', pinned !== null && parseInt(row.dataset.rev, 10) === pinned);
        }
    }

    // ----- Change vs change scatter

    function renderScatter(card, state, lines) {
        const present = lines.filter(l => !l.missing);
        const refIndex = Math.min(parseInt(state.sx, 10) || 0, present.length - 1);
        const ref = present[refIndex];
        const refByRev = new Map(ref.shown.map(p => [p.rev, p]));
        // The categorical palette separates at most three lines on a scatter
        const others = present.filter(l => l !== ref).slice(0, 3);

        const sets = others.map(line => {
            const pts = [];
            const common = line.shown.filter(p => refByRev.has(p.rev));
            for (let i = 1; i < common.length; ++i) {
                const a = common[i - 1], b = common[i];
                const ra = refByRev.get(a.rev), rb = refByRev.get(b.rev);
                const x = percentChange(ra.y, rb.y);
                const y = percentChange(a.y, b.y);
                if (x === null || y === null || !isFinite(x) || !isFinite(y)) continue;
                pts.push({ x, y, prevRev: a.rev, rev: b.rev });
            }
            return { line, pts };
        });

        const canvas = el('canvas', { role: 'img', 'aria-label': 'Change per commit of each line against the change of ' + ref.label });
        const wrap = el('div', { class: 'panel' },
                        el('div', { class: 'panel-label', text: '% change per commit' }), canvas);
        const legend = el('div', { class: 'legend' },
            el('span', { class: 'noise', text: 'x: ' + ref.label }),
            ...sets.map(s => el('span', { class: 'legend-item' },
                el('button', { type: 'button', 'aria-pressed': 'true', disabled: true },
                   el('span', { class: 'key dot', style: { background: lineColor(s.line) } }), 'y: ' + s.line.label))));
        const hint = el('p', { class: 'chart-hint', text: 'Each point is one commit: its % change in the x-axis line against its % change in the other line. On the diagonal both changed by the same fraction. Click a point to pin its commit.' });
        card.append(wrap, legend, hint);
        if (present.length - 1 > 3) {
            card.append(el('p', { class: 'notice', text: 'Showing three lines against the x-axis line; hide the others to compare them.' }));
        }

        scatter = makeScatter(canvas, sets, ref);
        scatter.draw();
        resizeObserver = new ResizeObserver(() => scatter.draw());
        resizeObserver.observe(card);
    }

    function niceTicks(min, max, count) {
        const span = max - min || 1;
        const step0 = span / count;
        const mag = Math.pow(10, Math.floor(Math.log10(step0)));
        const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || mag * 10;
        const ticks = [];
        for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(+v.toFixed(10));
        return ticks;
    }

    function makeScatter(canvas, sets, ref) {
        const pad = { left: 56, right: 16, top: 12, bottom: 40 };
        let geometry = null;

        function draw() {
            const dpr = window.devicePixelRatio || 1;
            const width = canvas.parentElement.clientWidth;
            const height = Math.min(460, Math.max(300, Math.round(width * 0.5)));
            canvas.style.width = width + 'px';
            canvas.style.height = height + 'px';
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
            const ctx = canvas.getContext('2d');
            ctx.scale(dpr, dpr);

            const all = sets.flatMap(s => s.pts);
            let xmin = Math.min(0, ...all.map(p => p.x)), xmax = Math.max(0, ...all.map(p => p.x));
            let ymin = Math.min(0, ...all.map(p => p.y)), ymax = Math.max(0, ...all.map(p => p.y));
            const xpad = (xmax - xmin) * 0.06 || 1, ypad = (ymax - ymin) * 0.06 || 1;
            xmin -= xpad; xmax += xpad; ymin -= ypad; ymax += ypad;
            const W = width - pad.left - pad.right, H = height - pad.top - pad.bottom;
            const sx = v => pad.left + (v - xmin) / (xmax - xmin) * W;
            const sy = v => pad.top + (1 - (v - ymin) / (ymax - ymin)) * H;
            geometry = { sx, sy };

            ctx.clearRect(0, 0, width, height);
            ctx.font = `12px ${cssVar('--font-ui')}`;
            ctx.lineWidth = 1;

            // Grid and ticks
            ctx.strokeStyle = cssVar('--grid');
            ctx.fillStyle = cssVar('--muted');
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            for (const t of niceTicks(xmin, xmax, Math.max(3, Math.floor(W / 90)))) {
                const x = Math.round(sx(t)) + 0.5;
                ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + H); ctx.stroke();
                ctx.fillText(formatPercent(t, 0), x, pad.top + H + 6);
            }
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            for (const t of niceTicks(ymin, ymax, Math.max(3, Math.floor(H / 60)))) {
                const y = Math.round(sy(t)) + 0.5;
                ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + W, y); ctx.stroke();
                ctx.fillText(formatPercent(t, 0), pad.left - 8, y);
            }
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText('% change per commit: ' + ref.label, pad.left + W / 2, height - 4);

            // Zero lines and the diagonal
            ctx.strokeStyle = cssVar('--axis');
            ctx.beginPath();
            ctx.moveTo(Math.round(sx(0)) + 0.5, pad.top); ctx.lineTo(Math.round(sx(0)) + 0.5, pad.top + H);
            ctx.moveTo(pad.left, Math.round(sy(0)) + 0.5); ctx.lineTo(pad.left + W, Math.round(sy(0)) + 0.5);
            ctx.stroke();
            const d0 = Math.max(xmin, ymin), d1 = Math.min(xmax, ymax);
            if (d1 > d0) {
                ctx.save();
                ctx.setLineDash([]);
                ctx.strokeStyle = cssVar('--muted');
                ctx.globalAlpha = 0.6;
                ctx.beginPath(); ctx.moveTo(sx(d0), sy(d0)); ctx.lineTo(sx(d1), sy(d1)); ctx.stroke();
                ctx.restore();
            }

            // Points: 8px with a 2px surface ring
            const surface = cssVar('--surface');
            for (const s of sets) {
                const color = lineColor(s.line);
                for (const p of s.pts) {
                    const x = sx(p.x), y = sy(p.y);
                    ctx.beginPath(); ctx.arc(x, y, 6, 0, 2 * Math.PI); ctx.fillStyle = surface; ctx.fill();
                    ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fillStyle = color; ctx.fill();
                    if (pinned === p.rev) {
                        ctx.beginPath(); ctx.arc(x, y, 8, 0, 2 * Math.PI);
                        ctx.strokeStyle = cssVar('--accent'); ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1;
                    }
                }
            }
        }

        function nearest(event) {
            if (!geometry) return null;
            const rect = canvas.getBoundingClientRect();
            const mx = event.clientX - rect.left, my = event.clientY - rect.top;
            let best = null, bestD = 24 * 24;
            for (const s of sets) {
                for (const p of s.pts) {
                    const dx = geometry.sx(p.x) - mx, dy = geometry.sy(p.y) - my;
                    const d = dx * dx + dy * dy;
                    if (d < bestD) { bestD = d; best = { set: s, p }; }
                }
            }
            return best;
        }

        canvas.addEventListener('mousemove', event => {
            const hit = nearest(event);
            const tooltip = document.getElementById('tooltip');
            if (!hit) { hideTooltip(); canvas.style.cursor = 'default'; return; }
            canvas.style.cursor = 'pointer';
            const { set, p } = hit;
            tooltip.replaceChildren(
                el('div', { class: 'tt-head' }, shortHash(p.rev), ' · ', formatDate(commitDate(p.rev), true)),
                commitSubject(p.rev) ? el('div', { class: 'tt-subject', text: commitSubject(p.rev) }) : null,
                el('div', { class: 'tt-row' }, el('span', { class: 'key', style: { background: cssVar('--muted') } }),
                   el('strong', { text: formatPercent(p.x) }), el('span', { class: 'tt-name', text: ref.label })),
                el('div', { class: 'tt-row' }, el('span', { class: 'key', style: { background: lineColor(set.line) } }),
                   el('strong', { text: formatPercent(p.y) }), el('span', { class: 'tt-name', text: set.line.label })));
            tooltip.hidden = false;
            placeTooltip(tooltip, event.clientX, event.clientY);
            if (hovered !== p.rev) { hovered = p.rev; renderCommitCard(); }
        });
        canvas.addEventListener('mouseleave', () => { hideTooltip(); hovered = null; renderCommitCard(); });
        canvas.addEventListener('click', event => {
            const hit = nearest(event);
            if (hit) pinCommit(pinned === hit.p.rev ? null : hit.p.rev);
        });

        return { draw };
    }

    // ------------------------------------------------------------------
    // Overview

    let overviewState = null;

    function renderOverview(state) {
        currentView = 'overview';
        destroyCharts();
        graphContext = null;
        overviewState = state;
        updateTree(state, []);
        const main = document.getElementById('main');

        const controls = el('div', { class: 'controls' },
            segmented('Show', state.show, [
                { value: 'changed', label: 'Changed recently' },
                { value: 'all', label: 'All benchmarks' },
            ], show => navigate({ show })),
            selectControl('Recently means', 'window', state.window, [
                { value: '10', label: 'Last 10 commits' }, { value: '25', label: 'Last 25 commits' },
                { value: '50', label: 'Last 50 commits' }, { value: '100', label: 'Last 100 commits' },
                { value: '100000', label: 'Any time' },
            ], window => navigate({ window })),
            selectControl('Smallest change', 'threshold', state.thr, [
                { value: '0', label: 'Any' }, { value: '0.5', label: '0.5%' }, { value: '1', label: '1%' },
                { value: '2', label: '2%' }, { value: '5', label: '5%' }, { value: '10', label: '10%' },
                { value: '25', label: '25%' },
            ], thr => navigate({ thr })));

        const selection = envSelection(state);
        const envRow = el('div', { class: 'controls' });
        for (const [param, values] of Object.entries(index.params)) {
            if (values.length < 2) continue;
            envRow.append(valueToggles(param, values, selection[param], v => v === null ? NONE : (v || '[default]'), next => {
                const env = Object.assign({}, state.env);
                env[param] = next;
                navigate({ env });
            }));
        }

        main.replaceChildren(
            el('div', { class: 'title-row' }, el('h1', { text: 'What changed' })),
            el('p', { class: 'subtitle', text: 'The last change beyond the noise of each benchmark, newest first. Timings count when the 99% confidence intervals of two consecutive commits do not overlap; counts count on any change.' }),
            controls,
            ...(envRow.childElementCount ? [envRow] : []),
            el('section', { class: 'card', id: 'overview-card', 'aria-label': 'Benchmarks' }));
        if (!changesIndex) {
            document.getElementById('overview-card').append(
                el('p', { class: 'notice', text: 'This site was published by an asv version that does not write changes.json; publish it again to see recent changes.' }));
        }
        renderOverviewRows();
    }

    function overviewEntries(state) {
        const selection = envSelection(state);
        const allRevs = Object.keys(index.revision_to_hash).map(Number).sort((a, b) => a - b);
        const threshold = parseFloat(state.thr) || 0;
        const windowSize = parseInt(state.window, 10) || 25;
        // Revisions with results, to count "commits ago"
        const withResults = new Set();
        for (const entries of Object.values(changesIndex || {})) {
            for (const e of entries) if (e.last) withResults.add(e.last[0]);
        }
        const resultRevs = allRevs;
        const latest = resultRevs[resultRevs.length - 1];
        const ago = rev => {
            const i = resultRevs.indexOf(rev);
            return i < 0 ? null : resultRevs.length - 1 - i;
        };

        const rows = [];
        for (const name of Object.keys(index.benchmarks)) {
            const bm = index.benchmarks[name];
            const entries = ((changesIndex || {})[name] || []).filter(e =>
                Object.entries(selection).every(([key, values]) => !(key in e.params) || values.includes(e.params[key])));
            let last = null;       // most recent qualifying change
            let largest = null;
            for (const e of entries) {
                const lc = e.last_change;
                if (lc) {
                    const pct = percentChange(lc[2], lc[3]);
                    if (pct !== null && Math.abs(pct) >= threshold && (!last || lc[1] > last.rev || (lc[1] === last.rev && Math.abs(pct) > Math.abs(last.pct)))) {
                        last = { rev: lc[1], prevRev: lc[0], pct, before: lc[2], after: lc[3], series: e.series };
                    }
                }
                const gc = e.largest_change;
                if (gc) {
                    const pct = percentChange(gc[2], gc[3]);
                    if (pct !== null && (!largest || Math.abs(pct) > Math.abs(largest.pct))) {
                        largest = { rev: gc[1], pct, series: e.series };
                    }
                }
            }
            const lastValue = entries.length === 1 && entries[0].last ? entries[0].last[1] : null;
            const agoCount = last ? ago(last.rev) : null;
            const recent = last && agoCount !== null && agoCount < windowSize;
            rows.push({ name, bm, entries, last, largest, lastValue, ago: agoCount, recent });
        }
        return { rows, latest };
    }

    function renderOverviewRows() {
        const card = document.getElementById('overview-card');
        if (!card || !overviewState) return;
        const state = overviewState;
        const query = document.getElementById('search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        let { rows } = overviewEntries(state);
        rows = rows.filter(r => query.every(w => r.name.toLowerCase().includes(w)));
        const shownRows = state.show === 'changed' ? rows.filter(r => r.recent) : rows;
        shownRows.sort((a, b) => {
            if (!!b.last - !!a.last) return !!b.last - !!a.last;
            if (a.last && b.last && b.last.rev !== a.last.rev) return b.last.rev - a.last.rev;
            if (a.last && b.last) return Math.abs(b.last.pct) - Math.abs(a.last.pct);
            return a.name < b.name ? -1 : 1;
        });

        if (!shownRows.length) {
            card.replaceChildren(el('p', { class: 'empty-state', text: state.show === 'changed'
                ? 'Nothing changed beyond the noise in this window. Choose a longer window or show all benchmarks.'
                : 'No benchmark matches the search.' }));
            return;
        }

        const tbody = el('tbody');
        for (const row of shownRows) {
            const { group, leaf } = splitName(row.name);
            const link = el('a', { href: hrefFor({ b: row.name, o: [], commit: row.last ? shortHash(row.last.rev) : null }) },
                            group ? el('span', { class: 'group', text: group + '.' }) : null, leaf);
            const spark = el('canvas', { class: 'spark', width: '240', height: '56', role: 'img',
                                         'aria-label': 'Trend of ' + row.name });
            const lastCell = row.last
                ? el('td', {},
                     el('div', {}, deltaNode(row.last.pct, row.bm.unit, true), ' ',
                        el('span', { class: 'noise num', text: formatValue(row.last.before, row.bm.unit) + ' → ' + formatValue(row.last.after, row.bm.unit) })),
                     el('div', { class: 'when' }, commitLink(row.last.rev), ' · ',
                        row.ago === 0 ? 'latest commit' : `${row.ago} commit${row.ago === 1 ? '' : 's'} ago`),
                     el('div', { class: 'subject', text: commitSubject(row.last.rev) }))
                : el('td', { class: 'noise', text: row.entries.length ? 'No change beyond the noise' : 'No results' });
            const largestCell = row.largest
                ? el('td', { class: 'num' }, deltaNode(row.largest.pct, row.bm.unit, true),
                     el('div', { class: 'when' }, commitLink(row.largest.rev)))
                : el('td', { class: 'num noise', text: '–' });
            tbody.append(el('tr', {},
                el('td', { class: 'bench' }, link, el('div', { class: 'when', text: row.bm.unit === 'unit' ? '' : row.bm.unit.replace(/_/g, ' ') })),
                el('td', {}, spark),
                el('td', { class: 'num' }, row.lastValue !== null ? formatValue(row.lastValue, row.bm.unit)
                    : el('span', { class: 'noise', text: row.entries.length > 1 ? `${row.entries.length} lines` : '–' })),
                lastCell, largestCell));
            drawSparkline(spark, row.name, row.last ? row.last.rev : null);
        }
        card.replaceChildren(
            el('div', { class: 'card-head' },
               el('h2', { text: state.show === 'changed' ? 'Changed recently' : 'All benchmarks' }),
               el('span', { class: 'chip', text: String(shownRows.length) })),
            el('div', { class: 'table-wrap' },
               el('table', { class: 'data overview-table' },
                  el('thead', {}, el('tr', {},
                     el('th', { text: 'Benchmark' }), el('th', { text: 'Trend' }), el('th', { class: 'num', text: 'Latest' }),
                     el('th', { text: 'Last change beyond the noise' }), el('th', { class: 'num', text: 'Largest change' }))),
                  tbody)));
    }

    async function drawSparkline(canvas, name, markRev) {
        const data = await loadJSON(graphPath(name, { summary: '' }), true);
        if (!data || !canvas.isConnected) return;
        const pts = data.filter(d => d[1] !== null && isFinite(d[1]));
        if (pts.length < 2) return;
        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height, p = 6;
        const xs = pts.map(d => d[0]), ys = pts.map(d => d[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs);
        const y0 = Math.min(...ys), y1 = Math.max(...ys);
        const sx = x => p + (x - x0) / ((x1 - x0) || 1) * (W - 2 * p);
        const sy = y => H - p - (y - y0) / ((y1 - y0) || 1) * (H - 2 * p);
        ctx.clearRect(0, 0, W, H);
        if (markRev !== null && markRev >= x0 && markRev <= x1) {
            ctx.strokeStyle = cssVar('--grid');
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(sx(markRev), 0); ctx.lineTo(sx(markRev), H); ctx.stroke();
        }
        ctx.strokeStyle = cssVar('--muted');
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        pts.forEach((d, i) => { const x = sx(d[0]), y = sy(d[1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.stroke();
        const last = pts[pts.length - 1];
        ctx.fillStyle = cssVar('--accent');
        ctx.beginPath(); ctx.arc(sx(last[0]), sy(last[1]), 4.5, 0, 2 * Math.PI); ctx.fill();
    }

    // ------------------------------------------------------------------
    // Routing

    let renderToken = 0;

    async function render() {
        const token = ++renderToken;
        const state = parseHash();
        hideTooltip();
        document.getElementById('nav-overview').toggleAttribute('aria-current', !state.b);
        if (!state.b) document.getElementById('nav-overview').setAttribute('aria-current', 'page');
        const classic = document.getElementById('nav-classic');
        classic.href = state.b ? 'index.html#' + state.b : 'index.html';
        try {
            if (state.b && index.benchmarks[state.b]) {
                await renderGraph(state);
                document.title = displayName(state.b) + ' · ' + (index.project || 'airspeed velocity');
            } else {
                renderOverview(state);
                document.title = 'What changed · ' + (index.project || 'airspeed velocity');
            }
        } catch (err) {
            if (token !== renderToken) return;
            console.error(err);
            document.getElementById('main').replaceChildren(
                el('p', { class: 'notice', text: 'Could not load the results: ' + err.message }));
        }
    }

    async function init() {
        try {
            const info = await loadJSON('info.json');
            timestamp = info.timestamp || '';
            [index, changesIndex] = await Promise.all([loadJSON('index.json'), loadJSON('changes.json', true)]);
        } catch (err) {
            document.getElementById('main').replaceChildren(
                el('p', { class: 'notice', text: 'Could not load index.json. Is this the output of asv publish, served over HTTP? (' + err.message + ')' }));
            return;
        }
        document.getElementById('project-name').textContent = index.project || '';
        document.getElementById('brand').href = '#';
        buildTree();
        document.getElementById('search').addEventListener('input', applySearch);
        document.getElementById('sidebar-toggle').addEventListener('click', () => {
            const sidebar = document.getElementById('sidebar');
            const open = !sidebar.classList.contains('open');
            sidebar.classList.toggle('open', open);
            document.getElementById('sidebar-toggle').setAttribute('aria-expanded', String(open));
        });
        document.getElementById('nav-overview').addEventListener('click', event => {
            event.preventDefault();
            const state = parseHash();
            window.location.hash = formatHash({ o: [], env: state.env, p: {}, thr: state.thr });
        });
        window.addEventListener('hashchange', render);

        // Redraw in the viewer's theme when it changes
        const redraw = () => { if (graphContext || currentView === 'overview') render(); };
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw);
        new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

        render();
    }

    window.asvExplore = { parseHash, formatHash, graphPath, lineChanges, percentChange };
    init();
})();
