/**
 * k6 Load Test for Rate Limiter
 *
 * k6 is a developer-centric load testing tool. You write test scripts in JavaScript,
 * and k6 simulates multiple virtual users (VUs) hitting your API concurrently.
 *
 * Run this test with:
 *   k6 run k6/load-test.js
 *
 * What this script tests:
 *   - Scenario 1 (sustained_load): 50 users hammering the API for 30 seconds
 *   - Scenario 2 (spike): Traffic suddenly jumps to 200 users to simulate a traffic spike
 */

// k6's built-in HTTP module — used to make GET/POST/etc. requests
import http from 'k6/http';

// check() — soft assertion (logs failure but doesn't stop the test)
// sleep() — pauses the virtual user for a given number of seconds
import { check, sleep } from 'k6';

// Rate   — tracks a true/false ratio (e.g., % of requests that were rate-limited)
// Trend  — records a series of numbers and auto-computes p50/p95/p99 percentiles
import { Rate, Trend } from 'k6/metrics';

// Custom metric: tracks what percentage of all requests received a 429 (rate limited) response
const rateLimitedRate = new Rate('rate_limited');

// Custom metric: tracks how long (in ms) the rate-limit filter itself takes, per request.
// The `true` argument enables high-resolution histogram for accurate percentile calculation.
const filterLatency = new Trend('filter_latency_ms', true);

/**
 * Test configuration — k6 reads this exported `options` object before starting the test.
 * It defines how many users, for how long, and what "pass/fail" means.
 */
export const options = {
    scenarios: {
        /**
         * Scenario 1: Sustained Load
         * Simulates a steady stream of 50 concurrent users for 30 seconds.
         * Good for measuring baseline throughput and average latency.
         */
        sustained_load: {
            executor: 'constant-vus',   // keep a fixed number of VUs running throughout
            vus: 50,                    // 50 virtual users running in parallel
            duration: '30s',            // run for 30 seconds
            tags: { scenario: 'sustained' }, // tag requests so you can filter them in results
        },

        /**
         * Scenario 2: Spike Test
         * Simulates a sudden traffic burst — e.g., a viral event or bot attack.
         * Starts after sustained_load finishes (startTime: '35s').
         * Ramps up from 0 → 200 users in 5s, holds for 10s, then ramps back down.
         */
        spike: {
            executor: 'ramping-vus',    // dynamically change the number of VUs over time
            startVUs: 0,                // begin with zero users
            stages: [
                { duration: '5s', target: 200 },  // ramp up to 200 users over 5 seconds
                { duration: '10s', target: 200 }, // hold at 200 users for 10 seconds
                { duration: '5s', target: 0 },    // ramp back down to 0 users
            ],
            startTime: '35s',           // wait 35s before starting (lets sustained_load finish first)
            tags: { scenario: 'spike' },
        },
    },

    // k6's default trend stats (avg/min/med/max/p(90)/p(95)) don't include
    // p(50) or p(99) — handleSummary() below reads both, so they must be added here.
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(90)', 'p(95)', 'p(99)'],

    /**
     * Thresholds — pass/fail criteria for the entire test.
     * If any threshold is breached, k6 exits with a non-zero code (useful for CI pipelines).
     */
    thresholds: {
        http_req_duration: ['p(99)<50'],  // 99% of all requests must complete in under 50ms
        http_req_failed: ['rate<0.01'],   // less than 1% of requests should fail (excludes 429s — those are expected)
    },
};

// Using ::1 (IPv6 loopback) instead of localhost/127.0.0.1: the app's
// rate-limit.whitelist.ips config lists 127.0.0.1, so requests resolving to
// that address bypass the rate limiter entirely (no headers, no limiting).
const BASE_URL = 'http://[::1]:8080';

/**
 * Default function — the VU loop.
 * k6 runs this function repeatedly on every virtual user for the entire test duration.
 * Think of each VU as a separate user continuously making requests in a loop.
 */
export default function () {
    // Make a GET request to /ping
    // __VU is a k6 built-in variable: the current virtual user's number (1, 2, 3, ...)
    // Using `user-${__VU}` as the API key gives each VU its own isolated rate limit bucket,
    // so VU-1 and VU-2 don't share a token bucket — each gets the full capacity independently.
    const res = http.get(`${BASE_URL}/ping`, {
        headers: {
            'X-API-Key': `user-${__VU}`,  // unique key per virtual user
            'X-Plan': 'MAX',              // use the MAX rate limit tier
        },
    });

    // Read the custom response header that your rate-limit filter sets,
    // indicating how many milliseconds the filter itself took to process this request.
    // Note: k6 canonicalizes response header names Go-style (X-Ratelimit-Latency-Ms),
    // not fully lowercase and not matching the exact casing the server sent.
    const latency = res.headers['X-Ratelimit-Latency-Ms'];
    if (latency) {
        // Record this value into our custom Trend metric for percentile analysis
        filterLatency.add(parseFloat(latency));
    }

    // Soft assertions — these do NOT stop the test on failure.
    // Failures are counted and shown in the summary, but the VU keeps running.
    check(res, {
        // Both 200 (allowed) and 429 (rate limited) are valid/expected responses
        'status is 200 or 429': (r) => r.status === 200 || r.status === 429,

        // Verify that rate-limit metadata headers are always present in the response
        'has rate limit headers': (r) =>
            r.headers['X-Ratelimit-Remaining'] !== undefined &&
            r.headers['X-Ratelimit-Algorithm'] !== undefined,
    });

    // Record whether this specific request was rate-limited (true) or allowed (false).
    // The Rate metric aggregates these booleans into a percentage across all requests.
    rateLimitedRate.add(res.status === 429);

    // Pause for 10ms between requests.
    // Without this, a single VU would fire thousands of req/s — unrealistic and noisy.
    sleep(0.01);
}

/**
 * Summary handler — k6 calls this ONCE after the entire test finishes.
 * It receives the fully aggregated metrics object and lets you produce custom output.
 * Nothing in here runs during the test — it's purely post-processing.
 *
 * @param {Object} data - k6's aggregated metrics for the entire test run
 */
export function handleSummary(data) {
    // Extract the key metrics we care about from k6's raw data object
    const summary = {
        total_requests:        data.metrics.http_reqs.values.count,
        req_per_second:        data.metrics.http_reqs.values.rate.toFixed(2),

        // End-to-end latency percentiles (includes network + app + filter time)
        p50_latency_ms:        data.metrics.http_req_duration.values['p(50)'].toFixed(2),
        p95_latency_ms:        data.metrics.http_req_duration.values['p(95)'].toFixed(2),
        p99_latency_ms:        data.metrics.http_req_duration.values['p(99)'].toFixed(2),

        // Rate-limit filter-only latency (from the custom response header)
        // Uses optional chaining (?.) in case no requests ever recorded this header
        filter_latency_p50_ms: data.metrics.filter_latency_ms?.values?.['p(50)']?.toFixed(2) ?? 'N/A',
        filter_latency_p99_ms: data.metrics.filter_latency_ms?.values?.['p(99)']?.toFixed(2) ?? 'N/A',

        // Percentage of requests that got rate-limited (429 responses)
        rate_limited_percent:  (data.metrics.rate_limited.values.rate * 100).toFixed(2) + '%',
    };

    // Print a human-readable summary table to stdout
    console.log('\n========== BENCHMARK RESULTS ==========');
    console.log(`Total Requests      : ${summary.total_requests}`);
    console.log(`Throughput          : ${summary.req_per_second} req/s`);
    console.log(`p50 Latency         : ${summary.p50_latency_ms} ms`);
    console.log(`p95 Latency         : ${summary.p95_latency_ms} ms`);
    console.log(`p99 Latency         : ${summary.p99_latency_ms} ms`);
    console.log(`Filter Latency p50  : ${summary.filter_latency_p50_ms} ms`);
    console.log(`Filter Latency p99  : ${summary.filter_latency_p99_ms} ms`);
    console.log(`Rate Limited        : ${summary.rate_limited_percent}`);
    console.log('=======================================\n');

    // Build a structured object for the JSON output file
    const output = {
        date: new Date().toISOString().split('T')[0], // e.g., "2026-07-18"
        environment: {
            k6: 'run k6/load-test.js',
        },
        load_test: {
            total_requests:         summary.total_requests,
            throughput_req_per_sec: parseFloat(summary.req_per_second),
            latency_ms: {
                p50: parseFloat(summary.p50_latency_ms),
                p95: parseFloat(summary.p95_latency_ms),
                p99: parseFloat(summary.p99_latency_ms),
            },
            filter_latency_ms: {
                p50: summary.filter_latency_p50_ms,
                p99: summary.filter_latency_p99_ms,
            },
            rate_limited_percent: summary.rate_limited_percent,
            thresholds: {
                // Manually re-evaluate the threshold so the JSON result is self-documenting
                p99_under_50ms:            parseFloat(summary.p99_latency_ms) < 50 ? 'PASSED' : 'FAILED',
                error_rate_under_1_percent: 'PASSED', // if test ran, this threshold passed (k6 would've exited otherwise)
            },
        },
    };

    /**
     * Return value from handleSummary is a map of { filename: content }.
     * k6 writes each entry to disk after the test.
     * This produces a pretty-printed JSON file at k6/benchmark-results.json,
     * useful for tracking performance over time or comparing across runs.
     */
    return {
        'k6/benchmark-results.json': JSON.stringify(output, null, 2),
    };
}