package com.itsjaypatel.demo;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
                "rate-limit.token-bucket.tiers.FREE.capacity=50",
                "rate-limit.token-bucket.tiers.FREE.refill-rate=1",
                "rate-limit.whitelist.ips=",
                "rate-limit.whitelist.api-keys=",
                "rate-limit.whitelist.paths=/actuator/health"
        }
)
class ConcurrentRateLimitTest {

    private static final int CAPACITY = 50;
    private static final int THREADS = 200;
    private static final String TEST_API_KEY = "concurrent-test-key";

    @LocalServerPort
    private int port;

    @Autowired
    private StringRedisTemplate redisTemplate;

    private HttpClient httpClient;

    @BeforeEach
    void setUp() {
        httpClient = HttpClient.newHttpClient();
        Set<String> keys = redisTemplate.keys("rl:FREE:" + TEST_API_KEY);
        if (keys != null && !keys.isEmpty()) redisTemplate.delete(keys);
    }

    @Test
    void exactlyCapacityRequestsAllowed_under_concurrent_load() throws InterruptedException {
        AtomicInteger allowed = new AtomicInteger(0);
        AtomicInteger denied = new AtomicInteger(0);

        ExecutorService executor = Executors.newFixedThreadPool(THREADS);
        CountDownLatch startLatch = new CountDownLatch(1);
        CountDownLatch doneLatch = new CountDownLatch(THREADS);

        String url = "http://localhost:" + port + "/ping";

        for (int i = 0; i < THREADS; i++) {
            executor.submit(() -> {
                try {
                    startLatch.await();
                    HttpRequest request = HttpRequest.newBuilder()
                            .uri(URI.create(url))
                            .header("X-API-Key", TEST_API_KEY)
                            .GET()
                            .build();

                    HttpResponse<String> response = httpClient.send(
                            request, HttpResponse.BodyHandlers.ofString()
                    );

                    if (response.statusCode() == 200) allowed.incrementAndGet();
                    else if (response.statusCode() == 429) denied.incrementAndGet();
                } catch (Exception e) {
                    Thread.currentThread().interrupt();
                } finally {
                    doneLatch.countDown();
                }
            });
        }

        startLatch.countDown();
        doneLatch.await();
        executor.shutdown();

        System.out.println("\n=== Concurrent Accuracy Test Results ===");
        System.out.println("Threads fired  : " + THREADS);
        System.out.println("Capacity       : " + CAPACITY);
        System.out.println("Allowed (200)  : " + allowed.get());
        System.out.println("Denied  (429)  : " + denied.get());
        System.out.println("Total          : " + (allowed.get() + denied.get()));
        System.out.println("========================================\n");

        assertThat(allowed.get()).isEqualTo(CAPACITY);
        assertThat(denied.get()).isEqualTo(THREADS - CAPACITY);
    }
}
