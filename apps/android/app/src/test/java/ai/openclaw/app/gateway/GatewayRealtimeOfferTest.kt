package ai.openclaw.app.gateway

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class GatewayRealtimeOfferTest {
  @Test
  fun exchangesBoundedSdpUsingOnlyTheOfferCapability() =
    runBlocking {
      MockWebServer().use { server ->
        server.enqueue(MockResponse().setBody("v=0\r\nanswer"))
        val route = GatewayRealtimeOffer(server.url("/offer").toString(), OkHttpClient(), emptyMap()) { true }
        assertEquals("v=0\r\nanswer", route.exchange("synthetic-offer-capability", emptyMap(), "v=0\r\noffer"))
        val request = server.takeRequest()
        assertEquals("Bearer synthetic-offer-capability", request.getHeader("Authorization"))
        assertEquals("application/sdp; charset=utf-8", request.getHeader("Content-Type"))
        assertEquals("v=0\r\noffer", request.body.readUtf8())
      }
    }

  @Test
  fun rejectsRedirectsAndOversizedAnswersWithoutEchoingBodies() =
    runBlocking {
      for (response in listOf(
        MockResponse().setResponseCode(302).setHeader("Location", "https://example.invalid/offer"),
        MockResponse().setBody("v=0" + "x".repeat(262_144)),
        MockResponse().setResponseCode(401).setBody("synthetic-sensitive-provider-detail"),
      )) {
        MockWebServer().use { server ->
          server.enqueue(response)
          val route = GatewayRealtimeOffer(server.url("/offer").toString(), OkHttpClient(), emptyMap()) { true }
          val failure = runCatching { route.exchange("synthetic-offer-capability", emptyMap(), "v=0") }.exceptionOrNull()
          assertTrue(failure != null)
          assertFalse(failure?.message.orEmpty().contains("synthetic-sensitive"))
          assertEquals(1, server.requestCount)
        }
      }
    }

  @Test
  fun queuedOffersRecheckConnectionBeforeDestinationIo() =
    runBlocking {
      for (retireBeforeDispatch in listOf(false, true)) {
        MockWebServer().use { server ->
          val blocked = CompletableDeferred<Unit>()
          val release = CountDownLatch(1)
          server.dispatcher =
            object : okhttp3.mockwebserver.Dispatcher() {
              override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path == "/block") {
                  blocked.complete(Unit)
                  check(release.await(5, TimeUnit.SECONDS))
                }
                return MockResponse().setBody("v=0\r\nanswer")
              }
            }
          val dispatcher = okhttp3.Dispatcher().apply { maxRequests = 1 }
          val client = OkHttpClient.Builder().dispatcher(dispatcher).build()
          val current = AtomicBoolean(true)
          val lifetime = Job()
          val route = GatewayRealtimeOffer(server.url("/offer").toString(), client, emptyMap(), lifetime) { current.get() }
          val blockingRoute = GatewayRealtimeOffer(server.url("/block").toString(), client, emptyMap()) { true }
          try {
            val blocker = async { blockingRoute.exchange("synthetic-capability", emptyMap(), "v=0") }
            withTimeout(5_000) { blocked.await() }
            val queued =
              async(start = CoroutineStart.UNDISPATCHED) {
                runCatching { route.exchange("synthetic-capability", emptyMap(), "v=0") }
              }
            val queuedCall = dispatcher.queuedCalls().single()
            assertEquals("/offer", queuedCall.request().url.encodedPath)
            if (retireBeforeDispatch) current.set(false)
            // Model state-only retirement with cleanup held until after dispatch completes.
            assertTrue(lifetime.isActive)
            release.countDown()
            val result =
              withTimeout(5_000) {
                blocker.await()
                queued.await()
              }
            assertTrue(lifetime.isActive)
            assertEquals("/block", server.takeRequest().path)
            assertEquals("Obsolete offers must not reach the destination", if (retireBeforeDispatch) 1 else 2, server.requestCount)
            if (retireBeforeDispatch) {
              assertTrue(result.isFailure)
            } else {
              assertEquals("v=0\r\nanswer", result.getOrThrow())
              assertEquals("/offer", server.takeRequest().path)
            }
          } finally {
            release.countDown()
            lifetime.cancel()
            dispatcher.cancelAll()
            dispatcher.executorService.shutdown()
            client.connectionPool.evictAll()
          }
        }
      }
    }

  @Test
  fun inFlightOffersCancelOrRejectLateAnswers() =
    runBlocking {
      for (cancelLifetime in listOf(false, true)) {
        MockWebServer().use { server ->
          val received = CompletableDeferred<Unit>()
          val release = CountDownLatch(1)
          server.dispatcher =
            object : okhttp3.mockwebserver.Dispatcher() {
              override fun dispatch(request: RecordedRequest): MockResponse {
                received.complete(Unit)
                check(release.await(5, TimeUnit.SECONDS))
                return MockResponse().setBody("v=0\r\nanswer")
              }
            }
          val client = OkHttpClient()
          val lifetime = Job()
          val current = AtomicBoolean(true)
          val route = GatewayRealtimeOffer(server.url("/offer").toString(), client, emptyMap(), lifetime) { current.get() }
          try {
            val exchange = async { runCatching { route.exchange("synthetic-capability", emptyMap(), "v=0") } }
            withTimeout(5_000) { received.await() }
            val call = client.dispatcher.runningCalls().single()
            if (cancelLifetime) {
              lifetime.cancel()
              assertTrue(call.isCanceled())
              // Cancellation must complete without the server releasing its response.
            } else {
              current.set(false)
              assertTrue(lifetime.isActive)
              assertFalse(call.isCanceled())
              release.countDown()
            }
            assertTrue(withTimeout(5_000) { exchange.await() }.isFailure)
            assertEquals("Already-sent requests cannot be retracted", 1, server.requestCount)
          } finally {
            release.countDown()
            lifetime.cancel()
            client.dispatcher.cancelAll()
            client.dispatcher.executorService.shutdown()
            client.connectionPool.evictAll()
          }
        }
      }
    }

  @Test
  fun rejectsRetiredConnectionBeforeSendingAnOffer() =
    runBlocking {
      MockWebServer().use { server ->
        val route = GatewayRealtimeOffer(server.url("/offer").toString(), OkHttpClient(), emptyMap()) { false }
        assertTrue(runCatching { route.exchange("synthetic-offer-capability", emptyMap(), "v=0") }.isFailure)
        assertEquals(0, server.requestCount)
      }
    }
}
