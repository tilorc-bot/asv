# Licensed under a 3-clause BSD style license - see LICENSE.rst

import math
import os
import traceback

from . import step_detect, util
from .util import geom_mean_na, is_na, mean_na

# This is the maximum number of points to include in summary graphs.
# It is based on the number of pixels in the summary graph display on
# a recent Retina MacBook Pro (3840 pixels across the screen, divided
# by 5 summaries across, divided by 2 for good measure and to account
# for width of the line).
RESAMPLED_POINTS = 3840 / 5 / 2


class GraphSet:
    """Manage multiple :py:class:`Graph` objects"""

    def __init__(self):
        self._graphs = {}
        self._groups = {}
        super().__init__()

    def get_graph(self, benchmark_name, params):
        graph = Graph(benchmark_name, params)
        if graph.path not in self._graphs:
            self._graphs[graph.path] = graph
            self._groups.setdefault(benchmark_name, []).append(graph)
        return self._graphs[graph.path]

    def get_graph_group(self, benchmark_name):
        return self._groups.get(benchmark_name, [])

    def get_params(self):
        """Return all params used in graphs and their corresponding values set"""
        params = {}
        for graph in self._graphs.values():
            for key, value in graph.params.items():
                params.setdefault(key, set())
                if value:
                    params[key].add(value)
        return params

    def detect_steps(self, pool=None, dots=None):
        for graph in self._graphs.values():
            graph.detect_steps(pool)
            if dots is not None and pool is None:
                dots()

        # Wait for results to compute
        for graph in self._graphs.values():
            graph.get_steps()
            if dots is not None and pool is not None:
                dots()

    def get_summary_graphs(self, dots=None):
        for graphs in self._groups.values():
            yield make_summary_graph(graphs)
            if dots is not None:
                dots()

    def save(self, html_dir, dots=None):
        for graph in self._graphs.values():
            graph.save(html_dir)
            if dots is not None:
                dots()

    def __iter__(self):
        return iter(self._graphs.items())

    def __len__(self):
        return len(self._graphs)


class Graph:
    """
    Manages a single "line" in the resulting plots for the front end.

    Unlike "results", which contain the timings for a single commit,
    these contain the timings for a single benchmark.
    """

    def __init__(self, benchmark_name, params):
        """
        Initially the graph contains no data.  It must be added using
        multiple calls to `add_data_point`.

        Parameters
        ----------
        benchmark_name : str
            A unique string to identify the benchmark, and display in
            the frontend.

        params : dict of str -> str
            A dictionary of parameters describing the benchmark.

        """
        self.benchmark_name = benchmark_name
        self.params = params
        self.data_points = {}
        self.data_weights = {}
        self.data_intervals = {}

        self.path = self.get_file_path(self.params, benchmark_name)
        self.n_series = None
        self.scalar_series = True
        self._steps = None

    @classmethod
    def get_file_path(cls, params, benchmark_name):
        """
        Get a file path understood by the JS frontend, corresponding
        on the given parameters and benchmark_name.

        The implementation must match asv.js:graph_to_path
        """
        parts = []
        l = list(params.items())
        for key, val in l:
            if val is None:
                part = f'{key}-null'
            elif val:
                part = f'{key}-{val}'
            else:
                part = f'{key}'
            parts.append(util.sanitize_filename(part))
        parts.sort()
        parts.insert(0, 'graphs')
        parts.append(util.sanitize_filename(benchmark_name))
        return os.path.join(*parts)

    def add_data_point(self, revision, value, weight=None, interval=None):
        """
        Add a data point to the graph.

        Parameters
        ----------
        revision : int
            An integer value representing the commit revision in the commit log

        value : float or list
            The value(s) to plot in the benchmark.

        weight : float or list or None
            Weights corresponding to the values.
            Missing estimates are indicated with None.

        interval : (float, float) or list or None
            Confidence interval (low, high) of each value, if known.

        """
        self.data_points.setdefault(revision, [])
        self.data_weights.setdefault(revision, [])
        self.data_intervals.setdefault(revision, [])
        if not is_na(value):
            if not hasattr(value, '__len__'):
                value = [value]
                weight = [weight]
                interval = [interval]
            else:
                self.scalar_series = False

            if self.n_series is None:
                self.n_series = len(value)
            elif len(value) != self.n_series:
                raise ValueError("Mismatching number of data series in graph")

            if weight is None:
                weight = [None] * len(value)
            if interval is None:
                interval = [None] * len(value)

            self.data_points[revision].append(value)
            self.data_weights[revision].append(weight)
            self.data_intervals[revision].append(interval)

    def get_data(self):
        """
        Get the sorted and reduced data and weights.
        """

        if self.n_series is None:
            # No non-null data points
            self.n_series = 1

        def mean_axis0(v):
            if not v:
                return [None] * self.n_series
            return [mean_na(x[j] for x in v) for j in range(self.n_series)]

        # Average data over commit log
        val = []
        for k in self.data_points.keys():
            v = mean_axis0(self.data_points[k])
            w = mean_axis0(self.data_weights[k])
            val.append((k, v, w))
            del v, w
        val.sort()

        # Discard missing data at edges
        i = 0
        for i in range(len(val)):
            if any(not is_na(v) for v in val[i][1]):
                break
        else:
            i = len(val)

        j = i
        for j in range(len(val) - 1, i, -1):
            if any(not is_na(v) for v in val[j][1]):
                break

        val = val[i : j + 1]

        # Single-element series
        if self.scalar_series:
            val = [(k, v[0], w[0]) for k, v, w in val]

        return val

    def get_series_data(self):
        """
        Like `get_data`, but as ``(revision, [value, ...])`` also for a
        graph with a single series, and without weights.
        """
        if self.scalar_series:
            return [(rev, [v]) for rev, v, w in self.get_data()]
        return [(rev, v) for rev, v, w in self.get_data()]

    def get_intervals(self, revisions):
        """
        Get the confidence interval of each series at the given
        revisions, averaged like the values, as a list of
        ``(revision, [(low, high) or None, ...])``.
        """
        result = []
        for rev in revisions:
            entries = [entry for entry in self.data_intervals.get(rev, []) if entry is not None]
            series = []
            for j in range(self.n_series):
                pairs = [e[j] for e in entries if j < len(e) and e[j] is not None]
                pairs = [p for p in pairs if not is_na(p[0]) and not is_na(p[1])]
                if pairs:
                    series.append((mean_na(p[0] for p in pairs), mean_na(p[1] for p in pairs)))
                else:
                    series.append(None)
            result.append((rev, series))
        return result

    @property
    def detail_path(self):
        """
        Path of the file with the confidence intervals and detected steps,
        the graph's path under ``details/`` instead of ``graphs/``.
        """
        return os.path.join('details', os.path.relpath(self.path, 'graphs'))

    def save(self, html_dir):
        """
        Save the graph to a .json file used by the frontend, and the
        confidence intervals of its values (an empty list when unknown)
        to a second file under ``details/``.

        Parameters
        ----------
        html_dir : str
            The root of the HTML tree.
        """
        filename = os.path.join(html_dir, self.path + ".json")

        data = self.get_data()

        # Drop weights
        val = [v[:2] for v in data]

        util.write_json(filename, val, compact=True)

        interval = []
        for rev, series in self.get_intervals([v[0] for v in data]):
            if all(s is None for s in series):
                continue
            if self.scalar_series:
                interval.append([rev, series[0][0], series[0][1]])
            else:
                interval.append(
                    [
                        rev,
                        [None if s is None else s[0] for s in series],
                        [None if s is None else s[1] for s in series],
                    ]
                )

        if 'summary' not in self.params:
            # Written also when empty, so the frontend need not ask for
            # files that do not exist
            util.write_json(
                os.path.join(html_dir, self.detail_path + ".json"),
                {'interval': interval},
                compact=True,
            )

    def get_changes(self):
        """
        Commit-to-commit changes of each series that exceed the noise.

        A change between two consecutive commits with data counts when
        their confidence intervals do not overlap.  A series without any
        confidence intervals (e.g. a count from a track_ benchmark) is
        taken as exact, so any change counts.

        Returns
        -------
        changes : list of list of (prev_revision, revision, before, after)
            One list per series.
        """
        data = self.get_series_data()
        intervals = dict(self.get_intervals([v[0] for v in data]))
        result = []
        for j in range(self.n_series):
            points = [
                (rev, values[j], intervals[rev][j]) for rev, values in data if not is_na(values[j])
            ]
            exact = all(ci is None for rev, y, ci in points)
            changes = []
            for (rev_a, a, ci_a), (rev_b, b, ci_b) in zip(points, points[1:]):
                if exact:
                    significant = a != b
                elif ci_a is not None and ci_b is not None:
                    significant = ci_b[0] > ci_a[1] or ci_b[1] < ci_a[0]
                else:
                    significant = False
                if significant:
                    changes.append((rev_a, rev_b, a, b))
            result.append(changes)
        return result

    def detect_steps(self, pool=None):
        """
        Run step detection algorithm on the graph data.

        Afterward, the results can be obtained via get_steps()

        Parameters
        ----------
        pool : multiprocessing.Pool, optional
            Pool to use for asynchronous jobs.
            If not given, run in serial.

        """
        if self._steps is not None:
            # Already computed
            return

        val = self.get_data()

        if not val:
            # Nothing to compute
            self._steps = [[]] * self.n_series
            return

        if self.scalar_series:
            items = [val]
        else:
            items = [[(v[0], v[1][j], v[2][j]) for v in val] for j in range(self.n_series)]

        if pool is None:
            self._steps = [_compute_graph_steps(item, reraise=False) for item in items]
        else:
            self._steps = [pool.apply_async(_compute_graph_steps, (item,)) for item in items]

    def get_steps(self):
        """
        Return results from step detection.

        Returns
        -------
        steps : list of (left, right, val, min, err)
            Result of fitting a piecewise function to the graph.
            Missing data points do not necessarily belong in any piece.
            The values are: `left` (inclusive) and `right` (exclusive) specify
            a revision interval, `val` the median value in the interval, `min`
            the minimum value in the interval, and `err` the mean deviation from
            the median.

        """
        if self._steps is None:
            self.detect_steps()

        for j, item in enumerate(self._steps):
            if not isinstance(item, list):
                self._steps[j] = item.get()

        if self.scalar_series:
            return self._steps[0]
        else:
            return self._steps


def _compute_graph_steps(data, reraise=True):
    try:
        x = [d[0] for d in data]
        y = [d[1] for d in data]
        w = [d[2] for d in data]

        steps = step_detect.detect_steps(y, w)
        new_steps = []

        for left, right, cur_val, cur_min, cur_err in steps:
            new_steps.append((x[left], x[right - 1] + 1, cur_val, cur_min, cur_err))

        return new_steps
    except BaseException as exc:
        if reraise:
            raise util.ParallelFailure(str(exc), exc.__class__, traceback.format_exc())
        else:
            raise


def make_summary_graph(graphs):
    x, ys = _combine_graph_data(graphs)
    y = _compute_summary_data_series(*ys)
    val = list(zip(x, y))

    # Resample
    val = resample_data(val)

    # Return as a graph
    graph = Graph(graphs[0].benchmark_name, {'summary': ''})
    for x, y in val:
        graph.add_data_point(x, y)
    return graph


def _compute_summary_data_series(*ys):
    """
    Given a multiple input series:

    .. code-block::

           y0, y1, ...

    calculate summary data series:

    .. code-block::

           val = [geom_mean([y0[0], y1[0], ...]),
                  geom_mean([y0[1], y1[1], ...]),
                 ...]

    Missing data in each y-series is filled for each series
    separately, before averaging. Data points that are missing from
    all series are however marked missing.

    """
    # Fill missing data
    filled = [_fill_missing_data(y) for y in ys]

    # Compute geom mean of filled series
    res = []
    for i in range(len(ys[0])):
        # Average filled series, unless it's missing from all
        # original series
        if any(not is_na(y[i]) for y in ys):
            v = geom_mean_na(y[i] for y in filled)
        else:
            v = None
        res.append(v)
    return res


def _fill_missing_data(y, max_gap_fraction=0.1):
    """
    Fill missing data to series by linearly interpolating inside gaps
    that are smaller than ``max_gap_fraction`` of total available
    points.

    """
    # Count number of valid values in each series
    valid_count = sum(int(not is_na(v)) for v in y)
    max_gap_size = math.ceil(max_gap_fraction * valid_count)

    # Fill gaps of missing data in each series
    filled = list(y)
    prev = None
    prev_idx = 0

    for i, v in enumerate(y):
        if not is_na(v):
            gap_size = i - prev_idx - 1

            if 0 < gap_size <= max_gap_size and not is_na(prev):
                # Interpolate gap
                for k in range(1, gap_size + 1):
                    filled[prev_idx + k] = (v * k + (gap_size + 1 - k) * prev) / (gap_size + 1)

            prev = v
            prev_idx = i

    return filled


def _combine_graph_data(graphs):
    """
    Combine data series from multiple graphs to compatible form

    Parameters
    ----------
    graphs : list of Graph
        Input data.

    Returns
    -------
    x : list of float
        List of x-coordinates, in increasing order
    ys : list of list of float
        List of data series, [y0, y1, y2, ...],
        where y0, y1, y2, ... are each lists of y-coordinates
        corresponding to `x`, one for each data series in each graph.
        When some of the graphs do not have data for a given x-value,
        the missing data is indicated by None values.

    """
    datasets = [graph.get_data() for graph in graphs]
    n_series = sum(graph.n_series for graph in graphs)

    # Find distinct x-values
    x = set()
    for dataset in datasets:
        x.update(k for k, _, _ in dataset)

    x = sorted(x)
    x_idx = dict(zip(x, range(len(x))))

    # Get y-values
    ys = [[None] * len(x_idx) for j in range(n_series)]
    pos = 0
    for dataset, graph in zip(datasets, graphs):
        for k, v, dv in dataset:
            i = x_idx[k]
            if graph.scalar_series:
                v = [v]

            for j, y in enumerate(v):
                ys[pos + j][i] = y
        pos += graph.n_series

    return x, ys


def resample_data(val, num_points=RESAMPLED_POINTS):
    if len(val) < num_points:
        return val

    min_revision = min(x[0] for x in val)
    max_revision = max(x[0] for x in val)
    step_size = int((max_revision - min_revision) / num_points)

    if step_size == 0:
        step_size = max_revision - min_revision + 1

    new_val = []
    j = 0
    for i in range(min_revision + step_size, max_revision + step_size, step_size):
        chunk = []
        while j < len(val) and val[j][0] < i:
            chunk.append(val[j][1])
            j += 1
        if len(chunk):
            new_val.append((i, mean_na(chunk)))
    return new_val
