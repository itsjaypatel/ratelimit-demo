# Benchmarking Guide

This guide walks you through running the performance and accuracy tests for the rate limiting library from scratch — no
prior knowledge needed.

---

## Prerequisites

Install the following tools before starting:

### 1. Java 17+

```bash
java -version
```

If not installed: https://adoptium.net

### 2. Maven

```bash
mvn -version
```

If not installed: https://maven.apache.org/install.html

### 3. Docker

```bash
docker -version
```

If not installed: https://docs.docker.com/get-docker

### 4. k6 (load testing tool)

```bash
# macOS
brew install k6

# Linux
sudo snap install k6

# Windows
choco install k6
```

Verify: `k6 version`

---

## Step 1 — Start Redis

The rate limiter stores bucket state in Redis. Start it via Docker:

```bash
docker run -d --name redis -p 6379:6379 redis:7.2-alpine
```

Verify it's running:

```bash
docker ps | grep redis
```

---

## Step 2 — Install the Library Locally

The demo project depends on the `spring-boot-starter-ratelimit` library. Install it to your local Maven repository
first:

```bash
cd ../Rate\ Limiting\ Middlerware
./mvnw install -DskipTests
cd ../ratelimit-demo
```

---

## Step 3 — Run the Concurrent Accuracy Test

This test fires **200 threads simultaneously** against a bucket with capacity 50 and verifies exactly 50 requests are
allowed — proving the Redis Lua script is atomic under concurrent load.

```bash
mvn test -Dtest=ConcurrentRateLimitTest
```

Expected output:

```
=== Concurrent Accuracy Test Results ===
Threads fired  : 200
Capacity       : 50
Allowed (200)  : 50
Denied  (429)  : 150
Total          : 200
========================================
```

If the test passes, the rate limiter is provably correct under concurrency.

---

## Step 4 — Start the Demo Application

```bash
mvn spring-boot:run
```

Wait until you see:

```
Tomcat started on port 8080
```

Verify the app is up:

```bash
curl http://localhost:8080/ping
# Expected: pong
```

---

## Step 5 — Run the k6 Load Test

> Results are automatically saved to `k6/benchmark-results.json` after each run.


Open a **new terminal** (keep the app running) and run:

```bash
k6 run k6/load-test.js
```

This runs two scenarios:

- **Sustained load** — 50 virtual users for 30 seconds
- **Spike** — ramps up to 200 virtual users over 20 seconds

### What to look for

| Metric         | Where to find it          | Target         |
|----------------|---------------------------|----------------|
| Throughput     | `http_reqs` rate          | > 1,000 req/s  |
| p99 latency    | `http_req_duration p(99)` | < 50ms ✓       |
| Error rate     | `http_req_failed`         | < 1% ✓         |
| Rate limited % | `rate_limited`            | Shows 429 rate |

### Response headers to inspect manually

```bash
curl -v -H "X-API-Key: mykey" -H "X-Plan: FREE" http://localhost:8080/ping
```

Look for:

```
X-RateLimit-Remaining: 99.0
X-RateLimit-Limit: 100.0
X-RateLimit-Tier: FREE
X-RateLimit-Algorithm: TOKEN_BUCKET
X-RateLimit-Latency-Ms: 1
```

`X-RateLimit-Latency-Ms` is the time the filter spent in Redis — typically **< 2ms**.

---

## Step 6 — Trigger Rate Limiting Manually

To see a 429 response, send more requests than the FREE tier capacity (100):

```bash
for i in $(seq 1 110); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -H "X-API-Key: test-user" \
    http://localhost:8080/ping
done
```

You'll see 200s for the first 100 requests, then 429s after that.

---

## Benchmark Results (Recorded)

Tested on: MacBook (darwin/arm64), OpenJDK 22, Redis 7.2-alpine, k6 v2.1.0

### Concurrent Accuracy Test

| Metric          | Result         |
|-----------------|----------------|
| Threads fired   | 200            |
| Bucket capacity | 50             |
| Allowed (200)   | **50 — exact** |
| Denied (429)    | 150            |
| Over-admitted   | **0**          |

### Load Test

| Metric                    | Result           |
|---------------------------|------------------|
| Total requests            | 259,418          |
| Throughput                | **~4,715 req/s** |
| p50 latency               | 3.50ms           |
| p95 latency               | 19.66ms          |
| p99 latency               | **33.49ms**      |
| HTTP error rate           | **0%**           |
| p99 < 50ms threshold      | **PASSED**       |
| Error rate < 1% threshold | **PASSED**       |

> Note: `k6/load-test.js` targets `http://[::1]:8080` rather than `localhost`. Go's HTTP
> client (used by k6) prefers IPv4 when resolving `localhost`, which resolves to `127.0.0.1`
> — an address listed in `rate-limit.whitelist.ips` in `application.properties`. Requests
> from a whitelisted address skip the rate limiter entirely (no `X-RateLimit-*` headers),
> so hitting `127.0.0.1` directly would silently test nothing.

---

## Stopping Everything

```bash
# Stop the demo app
Ctrl+C in the app terminal

# Stop Redis
docker stop redis
```