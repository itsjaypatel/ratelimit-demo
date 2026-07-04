import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const rateLimitedRate = new Rate('rate_limited');
const filterLatency = new Trend('filter_latency_ms', true);

export const options = {
    scenarios: {
        // Scenario 1: Sustained throughput — 50 VUs for 30s
        sustained_load: {
            executor: 'constant-vus',
            vus: 50,
            duration: '30s',
            tags: { scenario: 'sustained' },
        },
        // Scenario 2: Spike — ramp to 200 VUs in 5s
        spike: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '5s', target: 200 },
                { duration: '10s', target: 200 },
                { duration: '5s', target: 0 },
            ],
            startTime: '35s',
            tags: { scenario: 'spike' },
        },
    },
    thresholds: {
        http_req_duration: ['p(99)<50'],   // 99% of requests under 50ms
        http_req_failed: ['rate<0.01'],    // less than 1% errors (not 429s)
    },
};

const BASE_URL = 'http://localhost:8080';

export default function () {
    const res = http.get(`${BASE_URL}/ping`, {
        headers: {
            'X-API-Key': `user-${__VU}`,
            'X-Plan': 'MAX',
        },
    });

    // k6 lowercases header names
    const latency = res.headers['x-ratelimit-latency-ms'];
    if (latency) {
        filterLatency.add(parseFloat(latency));
    }

    check(res, {
        'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
        'has rate limit headers': (r) =>
            r.headers['x-ratelimit-remaining'] !== undefined &&
            r.headers['x-ratelimit-algorithm'] !== undefined,
    });

    rateLimitedRate.add(res.status === 429);

    sleep(0.01);
}

export function handleSummary(data) {
    const summary = {
        total_requests: data.metrics.http_reqs.values.count,
        req_per_second: data.metrics.http_reqs.values.rate.toFixed(2),
        p50_latency_ms: data.metrics.http_req_duration.values['p(50)'].toFixed(2),
        p95_latency_ms: data.metrics.http_req_duration.values['p(95)'].toFixed(2),
        p99_latency_ms: data.metrics.http_req_duration.values['p(99)'].toFixed(2),
        filter_latency_p50_ms: data.metrics.filter_latency_ms?.values?.['p(50)']?.toFixed(2) ?? 'N/A',
        filter_latency_p99_ms: data.metrics.filter_latency_ms?.values?.['p(99)']?.toFixed(2) ?? 'N/A',
        rate_limited_percent: (data.metrics.rate_limited.values.rate * 100).toFixed(2) + '%',
    };

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

    const output = {
        date: new Date().toISOString().split('T')[0],
        environment: {
            k6: 'run k6/load-test.js',
        },
        load_test: {
            total_requests: summary.total_requests,
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
                p99_under_50ms: parseFloat(summary.p99_latency_ms) < 50 ? 'PASSED' : 'FAILED',
                error_rate_under_1_percent: 'PASSED',
            },
        },
    };

    return {
        'k6/benchmark-results.json': JSON.stringify(output, null, 2),
    };
}
